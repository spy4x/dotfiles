import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1.0.19"
import { assistant, line, user } from "./_fixtures.ts"
import {
  dominantModel,
  issuesInBrief,
  modelCounts,
  priceCalls,
  reviewerCandidates,
  reviewRounds,
  scanTranscript,
  taskClassOf,
  tokenCounts,
  worktreeBranches,
} from "./lane.ts"

const t = Deno.test
const SONNET = `claude-sonnet-5-5`
const OPUS = `claude-opus-5-5`

t(`prices each API response once, from the last usage line sharing its message id`, () => {
  // Three lines of one response: the first two carry a partial output count.
  const lines = [
    assistant(`m1`, SONNET, `2026-09-30T01:00:00.000Z`, { output_tokens: 5 }),
    assistant(`m1`, SONNET, `2026-09-30T01:00:01.000Z`, { output_tokens: 40 }),
    assistant(`m1`, SONNET, `2026-09-30T01:00:02.000Z`, {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 3000,
      cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 1000 },
    }),
  ]
  const { calls } = scanTranscript(lines)
  assertEquals(calls.length, 1)
  // $2/M input, $10/M output, $0.20/M read; 5-minute write 1.25x, 1-hour write 2x input price.
  // 1000*2 + 100*10 + 2000*2*1.25 + 1000*2*2 + 10000*0.2 = 14000 millionths.
  assertAlmostEquals(priceCalls(calls).cost, 0.014, 1e-12)
  assertEquals(tokenCounts(calls), {
    input: 1000,
    output: 100,
    cacheRead: 10_000,
    cacheWrite5m: 2000,
    cacheWrite1h: 1000,
  })
})

t(`takes the model from message.model, counting calls per answering model`, () => {
  const lines = [
    assistant(`m1`, SONNET, `2026-09-30T01:00:00.000Z`, {}),
    assistant(`m2`, OPUS, `2026-09-30T01:01:00.000Z`, {}),
    assistant(`m3`, OPUS, `2026-09-30T01:02:00.000Z`, {}),
    assistant(`m4`, `<synthetic>`, `2026-09-30T01:03:00.000Z`, {}),
  ]
  const counts = modelCounts(scanTranscript(lines).calls)
  assertEquals(counts, { [SONNET]: 1, [OPUS]: 2 })
  assertEquals(dominantModel(counts), OPUS)
})

t(`a tie between models goes to the model that answered first`, () => {
  assertEquals(dominantModel({ a: 2, b: 2 }), `a`)
})

t(`counts compactions, each tool call once and the most common effort`, () => {
  const lines = [
    assistant(`m1`, OPUS, `2026-09-30T01:00:00.000Z`, {}, [
      { type: `tool_use`, id: `t1`, name: `Read`, input: {} },
    ], { effort: `medium` }),
    assistant(`m1`, OPUS, `2026-09-30T01:00:01.000Z`, {}, [
      { type: `tool_use`, id: `t2`, name: `Bash`, input: { command: `ls` } },
    ], { effort: `medium` }),
    // The same tool call repeated on a later line of the same response counts once.
    assistant(`m1`, OPUS, `2026-09-30T01:00:02.000Z`, {}, [
      { type: `tool_use`, id: `t1`, name: `Read`, input: {} },
    ], { effort: `medium` }),
    line({ type: `system`, subtype: `compact_boundary`, timestamp: `2026-09-30T01:05:00.000Z` }),
    line({ type: `system`, subtype: `compact_boundary`, timestamp: `2026-09-30T01:06:00.000Z` }),
    assistant(`m2`, OPUS, `2026-09-30T01:07:00.000Z`, {}, [
      { type: `tool_use`, id: `t3`, name: `Edit`, input: {} },
    ], { effort: `high` }),
  ]
  const scan = scanTranscript(lines)
  assertEquals(scan.compactions, 2)
  assertEquals(scan.compactedAt, [`2026-09-30T01:05:00.000Z`, `2026-09-30T01:06:00.000Z`])
  assertEquals(scan.toolCalls, 3)
  assertEquals(scan.effort, `medium`)
})

t(`finds the PR a lane opened from the output of its gh pr create`, () => {
  const lines = [
    assistant(`m1`, OPUS, `2026-09-30T01:00:00.000Z`, {}, [
      { type: `tool_use`, id: `t1`, name: `Bash`, input: { command: `gh pr create --fill` } },
    ]),
    user(`2026-09-30T01:00:05.000Z`, [
      {
        type: `tool_result`,
        tool_use_id: `t1`,
        content: `https://github.com/spy4x/example/pull/12\n`,
      },
    ]),
    // A PR URL printed by some other command is not a PR the lane opened.
    assistant(`m2`, OPUS, `2026-09-30T01:01:00.000Z`, {}, [
      { type: `tool_use`, id: `t2`, name: `Bash`, input: { command: `gh pr view 3` } },
    ]),
    user(`2026-09-30T01:01:05.000Z`, [
      {
        type: `tool_result`,
        tool_use_id: `t2`,
        content: `https://github.com/spy4x/example/pull/3`,
      },
    ]),
  ]
  assertEquals(scanTranscript(lines).createdPrs, [`spy4x/example#12`])
})

t(`falls back to PRs the lane reports on a line starting with PR`, () => {
  const lines = [
    assistant(`m1`, OPUS, `2026-09-30T01:00:00.000Z`, {}, [
      { type: `text`, text: `Done.\nPR: https://github.com/spy4x/example/pull/9\nsee also pull/1` },
    ]),
  ]
  assertEquals(scanTranscript(lines).reportedPrs, [`spy4x/example#9`])
})

t(`reads the issue from a brief, from a repo issue URL or a closing keyword`, () => {
  assertEquals(
    issuesInBrief(`See spy4x/example/issues/12 and Closes #7`, `spy4x/example`),
    [12, 7],
  )
  assertEquals(issuesInBrief(`spy4x/other/issues/12`, `spy4x/example`), [])
  assertEquals(issuesInBrief(`nothing here`, null), [])
})

t(`names the worktree branch a brief points at, without a trailing dot`, () => {
  assertEquals(
    worktreeBranches(`Worktree: /x/worktrees/example/feat/add-thing. Base: main`),
    [{ repo: `example`, branch: `feat/add-thing` }],
  )
})

t(`classes a task by its description's keywords`, () => {
  assertEquals(taskClassOf(`Add TOTP second factor`), `auth/crypto`)
  assertEquals(taskClassOf(`Update the README`), `docs`)
  assertEquals(taskClassOf(`Add a table component`), `code`)
})

const REVIEW_PROMPT = `Review https://github.com/spy4x/example/pull/7 now.`

function reviewerScan() {
  return scanTranscript([
    user(`2026-09-30T02:00:00.000Z`, REVIEW_PROMPT),
    assistant(`r1`, OPUS, `2026-09-30T02:01:00.000Z`, { output_tokens: 1_000_000 }, [
      { type: `text`, text: `Findings below.\nVerdict: needs-fix` },
    ]),
    assistant(`r2`, OPUS, `2026-09-30T02:10:00.000Z`, { output_tokens: 500_000 }, [
      { type: `text`, text: `All fixed. Verdict: pass` },
    ]),
  ])
}

t(`splits a reviewer into one round per verdict, charging each round its own calls`, () => {
  const scan = reviewerScan()
  const cands = reviewerCandidates(scan, ``, new Map())
  assertEquals(cands, [`spy4x/example#7`])
  const rounds = reviewRounds(scan, cands, OPUS)
  assertEquals(rounds.map((r) => [r.verdict, r.pr, r.calls, r.cost]), [
    [`needs-fix`, `spy4x/example#7`, 1, 20],
    [`pass`, `spy4x/example#7`, 1, 10],
  ])
})

t(`one message with verdicts on two PRs shares its calls and cost between them`, () => {
  const scan = scanTranscript([
    user(`2026-09-30T02:00:00.000Z`, `Review https://github.com/spy4x/example/pull/7 and pull/8`),
    assistant(`r1`, OPUS, `2026-09-30T02:01:00.000Z`, { output_tokens: 1_000_000 }, [
      { type: `text`, text: `PR #7 verdict: pass\nPR #8 verdict: needs-fix` },
    ]),
  ])
  const rounds = reviewRounds(scan, [`spy4x/example#7`, `spy4x/example#8`], OPUS)
  assertEquals(rounds.map((r) => [r.pr, r.verdict, r.cost, r.calls]), [
    [`spy4x/example#8`, `needs-fix`, 10, 0.5],
    [`spy4x/example#7`, `pass`, 10, 0.5],
  ])
})

t(`finds a reviewer's PR from the branch its prompt names when no URL is given`, () => {
  const scan = scanTranscript([
    user(`2026-09-30T02:00:00.000Z`, `Review the diff in /x/worktrees/example/feat/add-thing.`),
  ])
  const cands = reviewerCandidates(
    scan,
    ``,
    new Map([[`spy4x/example/feat/add-thing`, `spy4x/example#5`]]),
  )
  assertEquals(cands, [`spy4x/example#5`])
})
