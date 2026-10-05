import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.19"
import { dirname, fromFileUrl, join } from "jsr:@std/path@1.1.6"
import { assistant, line, user, writeLane } from "./_fixtures.ts"
import {
  collect,
  commitAt,
  type DotfilesCommit,
  isoDateError,
  readDotfilesCommits,
  referencedIssues,
  toJsonl,
  UnpricedError,
} from "./collect.ts"
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
    if (cmd === `gh pr list -R spy4x/example --head feat/add-table --state all --json number`) {
      return Promise.resolve(`[{"number":12}]`)
    }
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

t(
  `records when the lane compacted and how many calls it made before its first review`,
  async () => {
    const dir = await tempProjects()
    try {
      await writeLane(dir, {
        id: `impl`,
        meta: { agentType: `implementer`, description: `Implement table` },
        lines: [
          ...implementerLines(`2026-09-30T01:00:00.000Z`),
          line({
            type: `system`,
            subtype: `compact_boundary`,
            timestamp: `2026-09-30T01:30:00.000Z`,
          }),
          assistant(
            `m2`,
            `claude-sonnet-5-5`,
            `2026-09-30T01:40:00.000Z`,
            { input_tokens: 10 },
            [],
          ),
          // The fix round after the review: neither its call nor its compaction is before review.
          line({
            type: `system`,
            subtype: `compact_boundary`,
            timestamp: `2026-09-30T02:30:00.000Z`,
          }),
          assistant(
            `m3`,
            `claude-sonnet-5-5`,
            `2026-09-30T03:00:00.000Z`,
            { input_tokens: 10 },
            [],
          ),
        ],
      })
      // A later review, written first: the count still stops at the earliest one.
      await writeLane(dir, {
        id: `arev`,
        meta: { agentType: `reviewer`, description: `Review PR 12` },
        lines: reviewerLines(`2026-09-30T04:00:00.000Z`, `2026-09-30T04:05:00.000Z`),
      })
      await writeLane(dir, {
        id: `rev`,
        meta: { agentType: `reviewer`, description: `Review PR 12` },
        lines: reviewerLines(`2026-09-30T02:00:00.000Z`, `2026-09-30T02:05:00.000Z`),
      })
      const [impl, rev] = await collect({ projectsDir: dir, exec: fakeExec() })
      assertEquals(impl.compactedAt, [`2026-09-30T01:30:00.000Z`, `2026-09-30T02:30:00.000Z`])
      assertEquals(impl.calls, 3)
      assertEquals(impl.callsBeforeReview, 2)
      assertEquals(rev.callsBeforeReview, null)
    } finally {
      await Deno.remove(dir, { recursive: true })
    }
  },
)

t(`a lane that picks up a PR reviewed before it started has no calls before review`, async () => {
  const dir = await tempProjects()
  try {
    await writeLane(dir, {
      id: `impl`,
      meta: { agentType: `implementer`, description: `Implement table` },
      lines: implementerLines(`2026-09-30T03:00:00.000Z`),
    })
    await writeLane(dir, {
      id: `rev`,
      meta: { agentType: `reviewer`, description: `Review PR 12` },
      lines: reviewerLines(`2026-09-30T02:00:00.000Z`, `2026-09-30T02:05:00.000Z`),
    })
    // The review of its own fix round comes after it started; it still gets no count.
    await writeLane(dir, {
      id: `arev`,
      meta: { agentType: `reviewer`, description: `Review PR 12` },
      lines: reviewerLines(`2026-09-30T04:00:00.000Z`, `2026-09-30T04:05:00.000Z`),
    })
    const rows = await collect({ projectsDir: dir, exec: fakeExec() })
    assertEquals(rows.find((r) => r.role === `implementer`)!.callsBeforeReview, null)
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

t(`leaves out lanes that start at or after --until`, async () => {
  const dir = await tempProjects()
  try {
    for (
      const [id, start] of [[`before`, `2026-09-30T01:59:59.000Z`], [
        `at`,
        `2026-09-30T02:00:00.000Z`,
      ]]
    ) {
      await writeLane(dir, {
        id,
        meta: { agentType: `implementer`, description: id },
        lines: implementerLines(start),
      })
    }
    const rows = await collect({
      projectsDir: dir,
      until: `2026-09-30T02:00:00Z`,
      exec: fakeExec(),
    })
    assertEquals(rows.map((r) => r.description), [`before`])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

t(`leaves out reviewer lanes that audit instead of reviewing a PR`, async () => {
  const dir = await tempProjects()
  try {
    await writeLane(dir, {
      id: `audit`,
      meta: { agentType: `reviewer`, description: `Audit the experiment kit` },
      lines: reviewerLines(`2026-09-30T02:00:00.000Z`, `2026-09-30T02:05:00.000Z`),
    })
    await writeLane(dir, {
      id: `rev`,
      meta: { agentType: `reviewer`, description: `Review PR 12` },
      lines: reviewerLines(`2026-09-30T02:00:00.000Z`, `2026-09-30T02:05:00.000Z`),
    })
    const rows = await collect({ projectsDir: dir, exec: fakeExec() })
    assertEquals(rows.map((r) => r.description), [`Review PR 12`])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

t(`stops on a call to a model with no price instead of counting it as $0`, async () => {
  // An implementer answered only by an unknown model, and a reviewer with one unknown call
  // among priced ones: both must stop the run.
  const cases: { agentType: string; lines: string[] }[] = [
    {
      agentType: `implementer`,
      lines: implementerLines(`2026-09-30T01:00:00.000Z`).map((l) =>
        l.replaceAll(`claude-sonnet-5-5`, `claude-unknown-9`)
      ),
    },
    {
      agentType: `reviewer`,
      lines: [
        ...reviewerLines(`2026-09-30T02:00:00.000Z`, `2026-09-30T02:05:00.000Z`),
        assistant(`r2`, `claude-opus-5-5`, `2026-09-30T02:06:00.000Z`, { input_tokens: 10 }),
        assistant(`r3`, `claude-unknown-9`, `2026-09-30T02:07:00.000Z`, { input_tokens: 10 }),
      ],
    },
  ]
  for (const { agentType, lines } of cases) {
    const dir = await tempProjects()
    try {
      await writeLane(dir, { id: `x`, meta: { agentType, description: `work` }, lines })
      const calls: string[] = []
      const error = await assertRejects(
        () => collect({ projectsDir: dir, exec: fakeExec(calls) }),
        UnpricedError,
      )
      assertStringIncludes(error.message, `claude-unknown-9 (calls: 1, lanes: 1)`)
      // It stops before asking gh anything.
      assertEquals(calls, [])
    } finally {
      await Deno.remove(dir, { recursive: true })
    }
  }
})

t(`finds a lane's PR by the branch its brief names when it never printed a PR URL`, async () => {
  const dir = await tempProjects()
  try {
    const start = `2026-09-30T01:00:00.000Z`
    await writeLane(dir, {
      id: `impl`,
      meta: { agentType: `implementer`, description: `Implement table` },
      lines: [
        user(start, `Worktree: /w/worktrees/example/feat/add-table. Closes #99.`),
        assistant(`m1`, `claude-sonnet-5-5`, start, { input_tokens: 10 }),
      ],
    })
    const calls: string[] = []
    const [row] = await collect({ projectsDir: dir, exec: fakeExec(calls) })
    assertEquals([row.prs, row.prSource], [[`spy4x/example#12`], `branch`])
    assertEquals(
      calls[0],
      `gh pr list -R spy4x/example --head feat/add-table --state all --json number`,
    )
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

t(`records issues a PR body names only when GitHub lists no closing issue`, async () => {
  const dir = await tempProjects()
  try {
    const start = `2026-09-30T01:00:00.000Z`
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
    const base = fakeExec()
    const exec: Exec = (command, args) => {
      const cmd = [command, ...args].join(` `)
      const withBody = (json: string, body: string) =>
        Promise.resolve(JSON.stringify({ ...JSON.parse(json), body }))
      if (cmd.startsWith(`gh pr view 5 -R spy4x/zeta`)) {
        return withBody(ZETA_PR_JSON, `Part of #9. Refs spy4x/other#4.`)
      }
      if (cmd.startsWith(`gh pr view 12 -R spy4x/example`)) {
        return withBody(PR_JSON, `Closes #12. Also see #7.`)
      }
      return base(command, args)
    }
    const [row] = await collect({ projectsDir: dir, exec })
    assertEquals(row.prInfo[`spy4x/zeta#5`].referencedIssues, [`spy4x/other#4`, `spy4x/zeta#9`])
    assertEquals(row.prInfo[`spy4x/zeta#5`].closingIssues, [])
    assertEquals(row.prInfo[`spy4x/example#12`].closingIssues, [12])
    assertEquals(row.prInfo[`spy4x/example#12`].referencedIssues, [])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

t(`referencedIssues reads bare, qualified and URL references, once each`, () => {
  const body = [
    `Part of #93, Refs #93.`,
    `See spy4x/ts-libs#7 and https://github.com/spy4x/zond/issues/12.`,
    `Not a PR link: https://github.com/spy4x/zond/pull/13.`,
  ].join(`\n`)
  assertEquals(referencedIssues(body, `spy4x/dotfiles`, 104), [
    `spy4x/dotfiles#93`,
    `spy4x/ts-libs#7`,
    `spy4x/zond#12`,
  ])
})

t(`referencedIssues leaves out the PR itself, hex colours, C# and HTML entities`, () => {
  const body = `This is #104. Colour #1a2b3c and #000000. C#12 and &#39; and see #5.`
  assertEquals(referencedIssues(body, `spy4x/dotfiles`, 104), [`spy4x/dotfiles#5`])
  assertEquals(referencedIssues(`spy4x/dotfiles#104`, `spy4x/dotfiles`, 104), [])
})

/** Runs the collector command with `extra` flags and a `--projects` dir that does not exist. */
async function runCollect(extra: string[]): Promise<{ code: number; stderr: string }> {
  const dir = await tempProjects()
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [`run`, `-A`, COLLECT, `--out`, join(dir, `lanes.jsonl`), `--projects`, dir, ...extra],
      env: { PATH: `/usr/bin:/bin` },
      stdout: `piped`,
      stderr: `piped`,
    }).output()
    return { code: result.code, stderr: new TextDecoder().decode(result.stderr) }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

for (const name of [`--since`, `--until`]) {
  t(`${name} with a non-ISO value exits 2 with a one-line error`, async () => {
    const { code, stderr } = await runCollect([name, `yesterday`])
    assertEquals(code, 2)
    assertEquals(
      stderr.trim(),
      `${name} must be YYYY-MM-DD or a full ISO timestamp with a zone, got \`yesterday\``,
    )
  })

  t(`${name} with an impossible date exits 2`, async () => {
    const { code, stderr } = await runCollect([name, `2026-02-30`])
    assertEquals(code, 2)
    assertStringIncludes(stderr, `got \`2026-02-30\``)
  })

  t(`${name} with a valid date is accepted`, async () => {
    const { code, stderr } = await runCollect([name, `2026-09-30`])
    assertEquals([code, stderr.includes(`must be`)], [0, false])
  })

  t(`${name} with no value exits 2`, async () => {
    const { code } = await runCollect([name])
    assertEquals(code, 2)
  })
}

t(`isoDateError accepts dates and zoned timestamps and refuses the rest`, () => {
  for (const ok of [`2026-09-30`, `2026-09-30T01:02:03Z`, `2026-09-30T01:02:03.500+02:00`]) {
    assertEquals(isoDateError(`--since`, ok), null, ok)
  }
  for (
    const bad of [
      `2026-9-30`,
      `2026-09-30T01:02:03`, // no zone
      `2026-09-30 01:02:03Z`,
      `2026-13-01`,
      `2026-02-30`,
      `2026-09-30T25:00:00Z`,
      `2026-09-30T24:00:00Z`, // Date.parse reads this as the next midnight
      `2026-09-30T01:60:00Z`,
      `2026-09-30T01:00:60Z`,
      ``,
    ]
  ) {
    assertEquals(isoDateError(`--since`, bad) === null, false, bad)
  }
})

t(`referencedIssues ignores fenced code, inline code, file anchors and colours`, () => {
  const body = [
    "Real: Part of #5 and bar/qux#6.",
    "```",
    "#12 and bar/baz#13",
    "```",
    "~~~sh",
    "echo #15",
    "~~~",
    "Inline `#14` and ``#16``.",
    "See docs/guide.md#3-setup and docs/guide.md#4.",
    "Anchor #7-intro and bar/qux#8-intro.",
    "style: color: #123; background:#456;",
  ].join(`\n`)
  assertEquals(referencedIssues(body, `o/r`, 99), [`bar/qux#6`, `o/r#5`])
})

t(`referencedIssues still reads closing keywords and a number right after a colon`, () => {
  assertEquals(referencedIssues(`Closes #8. Fixes: #9. Resolves o/z#10`, `o/r`, 99), [
    `o/r#8`,
    `o/r#9`,
    `o/z#10`,
  ])
})

t(`referencedIssues reads a real reference after a word like border or fill`, () => {
  assertEquals(referencedIssues(`Closes the border: #16`, `o/r`, 99), [`o/r#16`])
  assertEquals(referencedIssues(`The fill: #17 is done.`, `o/r`, 99), [`o/r#17`])
})
