import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.19"
import { dirname, fromFileUrl, join } from "jsr:@std/path@1.1.6"
import { assistant, user, writeLane } from "./_fixtures.ts"
import { collect, commitAt, type DotfilesCommit, readDotfilesCommits, toJsonl } from "./collect.ts"
import { CommandError, denoExec, type Exec } from "./exec.ts"
import { SCHEMA_VERSION } from "./schema.ts"

const t = Deno.test
const COLLECT = join(dirname(fromFileUrl(import.meta.url)), `collect.ts`)

const PR_JSON = JSON.stringify({
  additions: 90,
  deletions: 10,
  state: `MERGED`,
  mergedAt: `2026-09-30T03:00:00Z`,
  createdAt: `2026-09-30T01:30:00Z`,
  title: `Add a table`,
  changedFiles: 3,
  headRefName: `feat/add-table`,
  closingIssuesReferences: [{ number: 12 }],
})

/** A second PR, in another repo, that closes no issue. */
const ZETA_PR_JSON = JSON.stringify({
  ...JSON.parse(PR_JSON),
  headRefName: `feat/zeta`,
  closingIssuesReferences: [],
})

const GIT_LOG = [
  `ccc3333\t2026-09-30T02:00:00+00:00`,
  `bbb2222\t2026-09-30T00:30:00+00:00`,
  `aaa1111\t2026-09-29T00:00:00+00:00`,
].join(`\n`)

/** A fake `gh` and `git`: answers the calls the collector makes and records them. */
function fakeExec(calls: string[] = [], fail?: (cmd: string) => boolean): Exec {
  return (command, args) => {
    const cmd = [command, ...args].join(` `)
    calls.push(cmd)
    if (fail?.(cmd)) return Promise.reject(new CommandError(command, args, `exit 1: boom`))
    if (command === `git`) return Promise.resolve(GIT_LOG)
    if (cmd.startsWith(`gh pr view 12 -R spy4x/example`)) return Promise.resolve(PR_JSON)
    if (cmd.startsWith(`gh pr view 5 -R spy4x/zeta`)) return Promise.resolve(ZETA_PR_JSON)
    return Promise.reject(new CommandError(command, args, `unexpected call in test`))
  }
}

async function tempProjects(): Promise<string> {
  return await Deno.makeTempDir({ prefix: `experiment-kit-test-` })
}

/** The implementer lane: asked for the alias `sonnet`, answered by sonnet-5-5, opened PR 12. */
function implementerLines(start: string): string[] {
  return [
    user(start, `Implement the table. Closes #99. Base is main.`),
    assistant(`m1`, `claude-sonnet-5-5`, start, { input_tokens: 1000, output_tokens: 100 }, [
      { type: `tool_use`, id: `t1`, name: `Bash`, input: { command: `gh pr create --fill` } },
    ], { effort: `medium` }),
    user(start, [
      {
        type: `tool_result`,
        tool_use_id: `t1`,
        content: `https://github.com/spy4x/example/pull/12`,
      },
    ]),
  ]
}

function reviewerLines(start: string, end: string): string[] {
  return [
    user(start, `Review https://github.com/spy4x/example/pull/12`),
    assistant(`r1`, `claude-opus-5-5`, end, { input_tokens: 1_000_000 }, [
      { type: `text`, text: `Verdict: needs-fix` },
    ]),
  ]
}

t(`writes one row per lane with a schema version, linking the PR, issue and review`, async () => {
  const dir = await tempProjects()
  try {
    await writeLane(dir, {
      id: `impl`,
      meta: { agentType: `implementer`, description: `Implement table`, model: `sonnet` },
      lines: implementerLines(`2026-09-30T01:00:00.000Z`),
    })
    await writeLane(dir, {
      id: `rev`,
      meta: { agentType: `reviewer`, description: `Review PR 12` },
      lines: reviewerLines(`2026-09-30T02:00:00.000Z`, `2026-09-30T02:05:00.000Z`),
    })
    const rows = await collect({ projectsDir: dir, exec: fakeExec() })
    assertEquals(rows.length, 2)
    const [impl, rev] = rows
    assertEquals(impl.schema, SCHEMA_VERSION)
    assertEquals(impl.role, `implementer`)
    assertEquals(impl.agentType, `implementer`)
    assertEquals(impl.effort, `medium`)
    assertEquals(impl.repo, `spy4x/example`)
    assertEquals(impl.prs, [`spy4x/example#12`])
    assertEquals(impl.prSource, `create`)
    // The brief says Closes #99; the brief wins over the PR's closing reference (#12).
    assertEquals([impl.issue, impl.issueSource], [99, `brief`])
    assertEquals(impl.mergedLines, 100)
    assertEquals(impl.taskClass, `code`)
    assertEquals(impl.baseCommit, null)
    assertEquals(impl.toolCalls, 1)
    assertEquals(impl.wallSeconds, 0)
    assertEquals(impl.reviews[`spy4x/example#12`].map((r) => r.verdict), [`needs-fix`])
    assertEquals(rev.role, `reviewer`)
    assertEquals(rev.rounds.map((r) => [r.verdict, r.pr, r.cost]), [
      [`needs-fix`, `spy4x/example#12`, 4],
    ])
    // JSONL: every line parses and carries the schema field.
    const text = toJsonl(rows)
    const parsed = text.trimEnd().split(`\n`).map((l) => JSON.parse(l))
    assertEquals(parsed.map((r) => r.schema), [1, 1])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

t(`counts changed lines as merged only when the PR is merged`, async () => {
  const dir = await tempProjects()
  try {
    await writeLane(dir, {
      id: `impl`,
      meta: { agentType: `implementer`, description: `Implement table` },
      lines: implementerLines(`2026-09-30T01:00:00.000Z`),
    })
    const open: Exec = (command, args) =>
      command === `gh`
        ? Promise.resolve(PR_JSON.replace(`"state":"MERGED"`, `"state":"OPEN"`))
        : fakeExec()(command, args)
    const [row] = await collect({ projectsDir: dir, exec: open })
    assertEquals(row.prInfo[`spy4x/example#12`].state, `OPEN`)
    assertEquals(row.mergedLines, 0)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

t(`records the model that answered, not the alias the Agent call asked for`, async () => {
  const dir = await tempProjects()
  try {
    await writeLane(dir, {
      id: `impl`,
      // The alias `opus` is what was asked for; message.model says what answered.
      meta: { agentType: `implementer`, description: `Implement table`, model: `opus` },
      lines: implementerLines(`2026-09-30T01:00:00.000Z`),
    })
    const [row] = await collect({ projectsDir: dir, exec: fakeExec() })
    assertEquals(row.requestedModel, `opus`)
    assertEquals(row.model, `claude-sonnet-5-5`)
    assertEquals(row.models, { "claude-sonnet-5-5": 1 })
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

t(`dates a lane by its message timestamps, not by the file's modification time`, async () => {
  const dir = await tempProjects()
  try {
    // Old messages in a file touched just now; new messages in a file last touched in 2020.
    const old = await writeLane(dir, {
      id: `old`,
      meta: { agentType: `implementer`, description: `old work` },
      lines: implementerLines(`2026-09-24T01:00:00.000Z`),
    })
    const fresh = await writeLane(dir, {
      id: `fresh`,
      meta: { agentType: `implementer`, description: `fresh work` },
      lines: implementerLines(`2026-09-30T01:00:00.000Z`),
    })
    await Deno.utime(old.transcriptPath, new Date(), new Date())
    await Deno.utime(
      fresh.transcriptPath,
      new Date(`2020-01-01T00:00:00Z`),
      new Date(`2020-01-01T00:00:00Z`),
    )
    const rows = await collect({
      projectsDir: dir,
      since: `2026-09-26T00:00:00Z`,
      exec: fakeExec(),
    })
    assertEquals(rows.map((r) => r.description), [`fresh work`])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

t(`tags each lane with the dotfiles commit live when it spawned`, async () => {
  const dir = await tempProjects()
  try {
    await writeLane(dir, {
      id: `early`,
      meta: { agentType: `implementer`, description: `early` },
      lines: implementerLines(`2026-09-30T00:45:00.000Z`),
    })
    await writeLane(dir, {
      id: `late`,
      meta: { agentType: `implementer`, description: `late` },
      lines: implementerLines(`2026-09-30T02:30:00.000Z`),
    })
    const calls: string[] = []
    const rows = await collect({
      projectsDir: dir,
      dotfilesDir: `/fake/dotfiles`,
      dotfilesRef: `origin/main`,
      exec: fakeExec(calls),
    })
    assertEquals(rows.map((r) => [r.description, r.dotfilesCommit]), [
      [`early`, `bbb2222`],
      [`late`, `ccc3333`],
    ])
    assertEquals(
      calls[0],
      `git -C /fake/dotfiles log --first-parent --format=%H%x09%cI origin/main`,
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

t(
  `commitAt picks the newest commit not later than the time, and null before the first`,
  async () => {
    const commits: DotfilesCommit[] = await readDotfilesCommits(fakeExec(), `/x`, `main`)
    assertEquals(commitAt(commits, `2026-09-30T02:00:00Z`), `ccc3333`)
    assertEquals(commitAt(commits, `2026-09-30T01:59:59Z`), `bbb2222`)
    assertEquals(commitAt(commits, `2026-09-28T00:00:00Z`), null)
  },
)

t(`a failed gh call stops collection instead of reporting no PRs`, async () => {
  const dir = await tempProjects()
  try {
    await writeLane(dir, {
      id: `impl`,
      meta: { agentType: `implementer`, description: `Implement table` },
      lines: implementerLines(`2026-09-30T01:00:00.000Z`),
    })
    const error = await assertRejects(
      () =>
        collect({ projectsDir: dir, exec: fakeExec([], (cmd) => cmd.startsWith(`gh pr view`)) }),
      CommandError,
    )
    assertStringIncludes(error.message, `gh pr view 12`)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

t(`the command exits non-zero and writes no file when gh fails`, async () => {
  const dir = await tempProjects()
  try {
    await writeLane(dir, {
      id: `impl`,
      meta: { agentType: `implementer`, description: `Implement table` },
      lines: implementerLines(`2026-09-30T01:00:00.000Z`),
    })
    // A fake gh that always fails. It never runs the real one.
    const bin = join(dir, `bin`)
    await Deno.mkdir(bin)
    await Deno.writeTextFile(
      join(bin, `gh`),
      `#!/bin/sh\necho "[]"\necho "gh: simulated outage" >&2\nexit 1\n`,
    )
    await Deno.chmod(join(bin, `gh`), 0o755)
    const out = join(dir, `lanes.jsonl`)
    const result = await new Deno.Command(Deno.execPath(), {
      args: [`run`, `-A`, COLLECT, `--out`, out, `--projects`, dir],
      env: { PATH: `${bin}:/usr/bin:/bin` },
      stdout: `piped`,
      stderr: `piped`,
    }).output()
    assertEquals(result.success, false)
    assertEquals(result.code, 1)
    assertStringIncludes(new TextDecoder().decode(result.stderr), `collect failed`)
    assertEquals(await Deno.stat(out).then(() => true, () => false), false)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

t(`records the commit live at the lane's first call, not at its last`, async () => {
  const dir = await tempProjects()
  try {
    // First call 00:45 (before ccc3333 at 02:00), last call 02:30 (after it).
    const lines = [
      ...implementerLines(`2026-09-30T00:45:00.000Z`),
      assistant(`m9`, `claude-sonnet-5-5`, `2026-09-30T02:30:00.000Z`, { input_tokens: 10 }),
    ]
    await writeLane(dir, {
      id: `long`,
      meta: { agentType: `implementer`, description: `long` },
      lines,
    })
    const [row] = await collect({ projectsDir: dir, dotfilesDir: `/fake`, exec: fakeExec() })
    assertEquals([row.start, row.end], [`2026-09-30T00:45:00.000Z`, `2026-09-30T02:30:00.000Z`])
    assertEquals(row.dotfilesCommit, `bbb2222`)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

t(`collects implementer-xhigh lanes as implementers and keeps the agent type`, async () => {
  const dir = await tempProjects()
  try {
    await writeLane(dir, {
      id: `xh`,
      meta: { agentType: `implementer-xhigh`, description: `fix round` },
      lines: implementerLines(`2026-09-30T01:00:00.000Z`),
    })
    const [row] = await collect({ projectsDir: dir, exec: fakeExec() })
    assertEquals([row.role, row.agentType], [`implementer`, `implementer-xhigh`])
    assertEquals(row.prs, [`spy4x/example#12`])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

t(
  `denoExec rejects with CommandError when the command exits non-zero, even with stdout`,
  async () => {
    const error = await assertRejects(
      () => denoExec(`sh`, [`-c`, `echo '[]'; echo oops >&2; exit 1`]),
      CommandError,
    )
    assertStringIncludes(error.message, `exit 1`)
    assertStringIncludes(error.message, `oops`)
    assertEquals(await denoExec(`sh`, [`-c`, `echo hi`]), `hi\n`)
  },
)

t(`the command warns on stderr when --dotfiles is not given`, async () => {
  const dir = await tempProjects()
  try {
    const out = join(dir, `lanes.jsonl`)
    const run = async (extra: string[]) => {
      const r = await new Deno.Command(Deno.execPath(), {
        args: [`run`, `-A`, COLLECT, `--out`, out, `--projects`, dir, ...extra],
        stdout: `piped`,
        stderr: `piped`,
      }).output()
      return new TextDecoder().decode(r.stderr)
    }
    assertStringIncludes(await run([]), `no --dotfiles given`)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

t(`takes a lane's closing reference from its first PR in sorted order`, async () => {
  const dir = await tempProjects()
  try {
    const start = `2026-09-30T01:00:00.000Z`
    // Opens spy4x/zeta#5 (closes nothing) before spy4x/example#12 (closes #12); the brief
    // names no issue.
    const create = (id: string, url: string) => [
      assistant(id, `claude-sonnet-5-5`, start, { input_tokens: 10 }, [
        {
          type: `tool_use`,
          id: `t-${id}`,
          name: `Bash`,
          input: { command: `gh pr create --fill` },
        },
      ]),
      user(start, [{ type: `tool_result`, tool_use_id: `t-${id}`, content: url }]),
    ]
    await writeLane(dir, {
      id: `impl`,
      meta: { agentType: `implementer`, description: `Implement table` },
      lines: [
        user(start, `Implement the table.`),
        ...create(`m1`, `https://github.com/spy4x/zeta/pull/5`),
        ...create(`m2`, `https://github.com/spy4x/example/pull/12`),
      ],
    })
    const [row] = await collect({ projectsDir: dir, exec: fakeExec() })
    assertEquals(row.prs, [`spy4x/zeta#5`, `spy4x/example#12`])
    assertEquals([row.issue, row.issueSource], [12, `closing-ref`])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
