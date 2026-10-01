import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.19"
import { dirname, fromFileUrl, join } from "jsr:@std/path@1.1.6"
import { laneRow } from "./_fixtures.ts"
import { CommandError, type Exec } from "./exec.ts"
import {
  buildRow,
  collectFollowups,
  type FileChange,
  followChanges,
  type FollowupInput,
  isGenerated,
  isRevertOf,
  mergedPrs,
  parseBlocks,
  parsePatch,
  remapRanges,
  touches,
  type WindowResult,
} from "./followup.ts"
import type { PrInfo } from "./schema.ts"

const t = Deno.test
const FOLLOWUP = join(dirname(fromFileUrl(import.meta.url)), `followup.ts`)

/** The original PR adds lines 10-12 of src/a.ts. */
const ORIGINAL_PATCH = `@@ -9,3 +9,6 @@ context
 line9
+new10
+new11
+new12
 line10
 line11`

/** Replaces old lines 11-12: overlaps the original's 10-12. */
const OVERLAPPING_PATCH = `@@ -11,2 +11,2 @@
-x
-y
+X
+Y`

/** Replaces old line 40: far from the original's lines. */
const DISTANT_PATCH = `@@ -40,1 +40,1 @@
-a
+b`

const MERGED = `2026-09-01T00:00:00Z`
const SHA = `abc1234def5678abc1234def5678abc1234def56`

function input(overrides: Partial<FollowupInput> = {}): FollowupInput {
  return {
    repo: `spy4x/example`,
    number: 10,
    title: `feat: add table`,
    mergedAt: MERGED,
    mergeCommit: SHA,
    files: [{ filename: `src/a.ts`, patch: ORIGINAL_PATCH }],
    laterPrs: [],
    laterCommits: [],
    reopens: [],
    ...overrides,
  }
}

const AFTER_30 = new Date(`2026-10-15T00:00:00Z`)

function later(number: number, mergedAt: string, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `chore: something ${number}`,
    body: ``,
    mergedAt,
    mergeCommit: `c${number}`.padEnd(40, `0`),
    files: [] as FileChange[],
    ...extra,
  }
}

function done(window: WindowResult | `pending`): WindowResult {
  if (window === `pending`) throw new Error(`window is pending`)
  return window
}

t(`parsePatch reports changed lines only, never context`, () => {
  assertEquals(parsePatch(ORIGINAL_PATCH), {
    old: [{ start: 9, end: 10 }], // a pure insertion: the old lines either side of it
    new: [{ start: 10, end: 12 }],
  })
})

t(`parsePatch reports a pure insertion as the two old lines around it`, () => {
  // Inserted after old line 10 (so between 10 and 11).
  assertEquals(parsePatch(`@@ -10,0 +11,1 @@\n+added`).old, [{ start: 10, end: 11 }])
})

t(`parsePatch reports a replaced block on both sides and a pure deletion as a point`, () => {
  assertEquals(parsePatch(OVERLAPPING_PATCH), {
    old: [{ start: 11, end: 12 }],
    new: [{ start: 11, end: 12 }],
  })
  assertEquals(parsePatch(`@@ -5,3 +5,2 @@\n a\n-b\n c`).new, [{ start: 5, end: 6 }])
})

/** Inserts five lines after old line 2: everything below moves down by five. */
const INSERT_ABOVE = `@@ -2,0 +3,5 @@\n+a\n+b\n+c\n+d\n+e`
const ORIGINAL = [{ filename: `src/a.ts`, patch: ORIGINAL_PATCH }]
const file = (patch: string, filename = `src/a.ts`) => [{ filename, patch }]

t(`followChanges finds a true touch after an intermediate PR shifted the lines down`, () => {
  // The original's lines 10-12 are now 15-17; a later PR rewriting line 16 touches them.
  const hits = followChanges(ORIGINAL, [
    { number: 20, files: file(INSERT_ABOVE) },
    { number: 21, files: file(`@@ -16,1 +16,1 @@\n-x\n+y`) },
  ])
  assertEquals([...hits.keys()], [21])
})

t(`followChanges does not call a later PR a touch when the lines moved away from it`, () => {
  // Line 11 overlapped the original's 10-12 before the insertion; after it, line 11 is not theirs.
  const hits = followChanges(ORIGINAL, [
    { number: 20, files: file(INSERT_ABOVE) },
    { number: 21, files: file(`@@ -11,1 +11,1 @@\n-x\n+y`) },
  ])
  assertEquals([...hits.keys()], [])
})

t(`followChanges follows lines that an intermediate PR moved up`, () => {
  // Deleting old lines 2-3 moves the original's 10-12 up to 8-10.
  const hits = followChanges(ORIGINAL, [
    { number: 20, files: file(`@@ -2,2 +2,0 @@\n-a\n-b`) },
    { number: 21, files: file(`@@ -8,1 +8,1 @@\n-x\n+y`) },
  ])
  assertEquals([...hits.keys()], [21])
})

t(`followChanges gives lines an intermediate PR rewrote to that PR, not to the next one`, () => {
  const hits = followChanges(ORIGINAL, [
    { number: 20, files: file(`@@ -10,3 +10,3 @@\n-1\n-2\n-3\n+A\n+B\n+C`) },
    { number: 21, files: file(`@@ -11,1 +11,1 @@\n-B\n+Z`) },
  ])
  assertEquals([...hits.keys()], [20])
})

t(`followChanges keeps the untouched part of a range a PR rewrote only in part`, () => {
  // PR 20 rewrites line 10 only; lines 11-12 stay the original's and PR 21 touches line 12.
  const hits = followChanges(ORIGINAL, [
    { number: 20, files: file(`@@ -10,1 +10,1 @@\n-1\n+A`) },
    { number: 21, files: file(`@@ -12,1 +12,1 @@\n-3\n+C`) },
  ])
  assertEquals([...hits.keys()], [20, 21])
})

t(`followChanges follows a renamed file and a rename keeps the lines`, () => {
  const hits = followChanges(ORIGINAL, [
    {
      number: 20,
      files: [{ filename: `src/b.ts`, previousFilename: `src/a.ts`, status: `renamed` }],
    },
    { number: 21, files: file(`@@ -11,1 +11,1 @@\n-x\n+y`, `src/b.ts`) },
  ])
  assertEquals([...hits.keys()], [21])
})

t(`followChanges ignores an overlap in a lockfile or other generated file`, () => {
  for (
    const name of [`deno.lock`, `pkg/package-lock.json`, `Cargo.lock`, `llms.txt`, `llms-full.txt`]
  ) {
    const original = [{ filename: name, patch: ORIGINAL_PATCH }]
    const hits = followChanges(original, [{ number: 20, files: file(OVERLAPPING_PATCH, name) }])
    assertEquals([...hits.keys()], [], name)
  }
  const golden = [{ filename: `tests/golden/out.txt`, patch: ORIGINAL_PATCH }]
  assertEquals(
    followChanges(golden, [{ number: 20, files: file(OVERLAPPING_PATCH, `tests/golden/out.txt`) }])
      .size,
    0,
  )
})

t(`isGenerated matches the generated files and no ordinary source file`, () => {
  for (const f of [`deno.lock`, `a/b/package-lock.json`, `x.lock`, `llms.txt`, `d/llms-full.txt`]) {
    assertEquals(isGenerated(f), true, f)
  }
  for (const f of [`src/a.ts`, `README.md`, `llms.ts`, `golden.ts`, `notes/llms.txt.md`]) {
    assertEquals(isGenerated(f), false, f)
  }
})

t(`remapRanges splits a range an insertion lands inside and shifts the part below`, () => {
  // Five lines inserted between old lines 10 and 11, inside the range 8-13.
  assertEquals(
    remapRanges([{ start: 8, end: 13 }], parseBlocks(`@@ -10,0 +11,5 @@\n+a\n+b\n+c\n+d\n+e`)),
    [{ start: 8, end: 10 }, { start: 16, end: 18 }],
  )
})

t(`touches finds a later change that overlaps the original's changed lines`, () => {
  const original = [{ filename: `src/a.ts`, patch: ORIGINAL_PATCH }]
  assertEquals(touches(original, [{ filename: `src/a.ts`, patch: OVERLAPPING_PATCH }]), {
    files: [`src/a.ts`],
    exact: true,
  })
})

t(`touches ignores a change in the same file outside the original's lines`, () => {
  const original = [{ filename: `src/a.ts`, patch: ORIGINAL_PATCH }]
  assertEquals(touches(original, [{ filename: `src/a.ts`, patch: DISTANT_PATCH }]), {
    files: [],
    exact: true,
  })
})

t(`touches ignores another file even when its line numbers overlap`, () => {
  const original = [{ filename: `src/a.ts`, patch: ORIGINAL_PATCH }]
  assertEquals(touches(original, [{ filename: `src/b.ts`, patch: OVERLAPPING_PATCH }]).files, [])
})

t(`touches follows a rename of the file through previousFilename`, () => {
  const original = [{ filename: `src/a.ts`, patch: ORIGINAL_PATCH }]
  const renamed = { filename: `src/c.ts`, previousFilename: `src/a.ts`, patch: OVERLAPPING_PATCH }
  assertEquals(touches(original, [renamed]).files, [`src/c.ts`])
})

t(`touches counts a file with no patch as touched whole and not exact`, () => {
  const original = [{ filename: `img.png` }]
  assertEquals(touches(original, [{ filename: `img.png` }]), { files: [`img.png`], exact: false })
})

t(`touches does not count a pure rename, which changes no lines`, () => {
  const original = [{ filename: `src/a.ts`, patch: ORIGINAL_PATCH }]
  const bare = { filename: `src/c.ts`, previousFilename: `src/a.ts`, status: `renamed` }
  assertEquals(touches(original, [bare]), { files: [], exact: true })
})

const TARGET = {
  repo: `spy4x/example`,
  number: 10,
  title: `feat: add table`, // as `gh pr view` returns it, without the squash commit's `(#10)`
  mergeCommit: SHA,
}

t(`isRevertOf matches the revert title, with or without the PR number suffix`, () => {
  assertEquals(isRevertOf(TARGET, { title: `Revert "feat: add table"`, body: `` }), true)
  assertEquals(
    isRevertOf(TARGET, { title: `Revert "feat: add table (#10)" (#14)`, body: `` }),
    true,
  )
  // `git revert` of the squash commit keeps its `(#10)`.
  assertEquals(isRevertOf(TARGET, { title: `Revert "feat: add table (#10)"`, body: `` }), true)
  assertEquals(isRevertOf(TARGET, { title: `Revert "feat: add table (#11)"`, body: `` }), false)
  assertEquals(isRevertOf(TARGET, { title: `Revert "feat: add chair"`, body: `` }), false)
})

t(`isRevertOf matches a body that names the merge commit by a prefix of its sha`, () => {
  const body = `This reverts commit ${SHA.slice(0, 9)}.`
  assertEquals(isRevertOf(TARGET, { title: `Undo the table`, body }), true)
  assertEquals(isRevertOf(TARGET, { title: `Undo`, body: `This reverts commit 1111111.` }), false)
})

t(
  `isRevertOf matches "Reverts #10" and "Reverts owner/repo#10" but not #100 or another repo`,
  () => {
    const revert = (body: string) => isRevertOf(TARGET, { title: `Undo`, body })
    assertEquals(revert(`Reverts #10`), true)
    assertEquals(revert(`Reverts spy4x/example#10`), true)
    assertEquals(revert(`Reverts #100`), false)
    assertEquals(revert(`Reverts spy4x/other#10`), false)
  },
)

t(`buildRow records a revert PR and a revert commit, and does not call a revert a fix`, () => {
  const row = buildRow(
    input({
      laterPrs: [
        later(11, `2026-09-03T00:00:00Z`, {
          title: `Revert "feat: add table"`,
          files: [{ filename: `src/a.ts`, patch: OVERLAPPING_PATCH }],
        }),
      ],
      laterCommits: [
        {
          sha: `d`.repeat(40),
          message: `Undo it\n\nThis reverts commit ${SHA}.`,
          at: `2026-09-05T00:00:00Z`,
        },
      ],
    }),
    AFTER_30,
  )
  const d14 = done(row.d14)
  assertEquals(d14.reverts.map((r) => [r.pr, r.sha === null ? null : r.sha[0]]), [
    [11, `c`],
    [null, `d`],
  ])
  assertEquals(d14.fixes, [])
})

t(`buildRow counts a commit that is a listed PR's merge commit once`, () => {
  const pr = later(11, `2026-09-03T00:00:00Z`, {
    title: `Revert "feat: add table"`,
    mergeCommit: `e`.repeat(40),
  })
  const row = buildRow(
    input({
      laterPrs: [pr],
      laterCommits: [{
        sha: `e`.repeat(40),
        message: `Revert "feat: add table"`,
        at: `2026-09-03T00:00:00Z`,
      }],
    }),
    AFTER_30,
  )
  assertEquals(done(row.d14).reverts.length, 1)
})

t(`buildRow records a later PR whose hunk overlaps as a fix and skips a distant one`, () => {
  const row = buildRow(
    input({
      laterPrs: [
        later(11, `2026-09-02T00:00:00Z`, {
          title: `fix(table): header`,
          files: [{ filename: `src/a.ts`, patch: OVERLAPPING_PATCH }],
        }),
        later(12, `2026-09-02T00:00:00Z`, {
          files: [{ filename: `src/a.ts`, patch: DISTANT_PATCH }],
        }),
        later(13, `2026-09-04T00:00:00Z`, {
          title: `docs: mention table`,
          // Line 10 is still the original's: PR 11 replaced only lines 11-12.
          files: [{ filename: `src/a.ts`, patch: `@@ -10,1 +10,1 @@\n-p\n+q` }],
        }),
      ],
    }),
    AFTER_30,
  )
  assertEquals(
    done(row.d14).fixes.map((f) => [f.pr, f.fixType, f.files, f.exact]),
    [[11, true, [`src/a.ts`], true], [13, false, [`src/a.ts`], true]],
  )
})

t(`buildRow compares each later PR in merge order, whatever order gh listed them`, () => {
  // Listed newest first, as `gh pr list` does. The insertion (day 2) must be applied before the
  // rewrite of line 16 (day 3), so the rewrite touches the original's shifted lines.
  const row = buildRow(
    input({
      laterPrs: [
        later(12, `2026-09-03T00:00:00Z`, { files: file(`@@ -16,1 +16,1 @@\n-x\n+y`) }),
        later(11, `2026-09-02T00:00:00Z`, { files: file(INSERT_ABOVE) }),
      ],
    }),
    AFTER_30,
  )
  assertEquals(done(row.d14).fixes.map((f) => f.pr), [12])
})

t(`buildRow puts an event in the 30 day window only when it falls after day 14`, () => {
  const row = buildRow(
    input({
      laterPrs: [
        later(11, `2026-09-20T00:00:00Z`, {
          files: [{ filename: `src/a.ts`, patch: OVERLAPPING_PATCH }],
        }),
        // Day 31: outside both windows.
        later(12, `2026-10-02T00:00:00Z`, {
          files: [{ filename: `src/a.ts`, patch: OVERLAPPING_PATCH }],
        }),
      ],
    }),
    AFTER_30,
  )
  assertEquals(done(row.d14).fixes, [])
  assertEquals(done(row.d30).fixes.map((f) => f.pr), [11])
})

t(`buildRow records a reopened issue in the windows that contain it`, () => {
  const row = buildRow(
    input({
      reopens: [
        { issue: `spy4x/example#7`, at: `2026-09-10T00:00:00Z` },
        { issue: `spy4x/example#7`, at: `2026-08-31T00:00:00Z` }, // before the merge
      ],
    }),
    AFTER_30,
  )
  assertEquals(done(row.d14).reopened, [{ issue: `spy4x/example#7`, at: `2026-09-10T00:00:00Z` }])
  assertEquals(done(row.d30).reopened, [{ issue: `spy4x/example#7`, at: `2026-09-10T00:00:00Z` }])
})

t(`buildRow writes pending, never an empty result, for a window that has not elapsed`, () => {
  const early = buildRow(input(), new Date(`2026-09-10T00:00:00Z`))
  assertEquals([early.d14, early.d30], [`pending`, `pending`])
  const middle = buildRow(input(), new Date(`2026-09-20T00:00:00Z`))
  assertEquals(middle.d14, { reverts: [], fixes: [], reopened: [] })
  assertEquals(middle.d30, `pending`)
  // The window ends exactly 14 days after the merge.
  assertEquals(buildRow(input(), new Date(`2026-09-15T00:00:00Z`)).d14 === `pending`, false)
  assertEquals(buildRow(input(), new Date(`2026-09-14T23:59:59Z`)).d14, `pending`)
})

t(`mergedPrs lists each merged PR once and leaves out open and closed ones`, () => {
  const info = (state: string, mergedAt: string | null): PrInfo => ({
    additions: 1,
    deletions: 1,
    state,
    mergedAt,
    createdAt: MERGED,
    title: `t`,
    headRefName: `b`,
    closingIssues: [],
  })
  const rows = [
    laneRow({
      prInfo: {
        "spy4x/example#10": info(`MERGED`, MERGED),
        "spy4x/example#11": info(`OPEN`, null),
        "spy4x/example#12": info(`CLOSED`, null),
      },
    }),
    laneRow({ prInfo: { "spy4x/example#10": info(`MERGED`, MERGED) } }),
  ]
  assertEquals(mergedPrs(rows), [{ repo: `spy4x/example`, number: 10 }])
})

// ===== The gh shell =====

const PRS: Record<string, unknown> = {
  "10": {
    title: `feat: add table`,
    mergedAt: MERGED,
    mergeCommit: { oid: SHA },
    closingIssuesReferences: [
      { number: 7, repository: { name: `example`, owner: { login: `spy4x` } } },
    ],
  },
}

/** A fake `gh` for repo spy4x/example, with the PR of `ORIGINAL_PATCH` and one later fix. */
function fakeGh(options: { fail?: (cmd: string) => boolean; listed?: number } = {}): Exec {
  return (command, args) => {
    const cmd = [command, ...args].join(` `)
    if (options.fail?.(cmd)) return Promise.reject(new CommandError(command, args, `exit 1: boom`))
    const json = (value: unknown) => Promise.resolve(JSON.stringify(value))
    if (cmd.startsWith(`gh repo view spy4x/example`)) {
      return json({ defaultBranchRef: { name: `main` } })
    }
    if (cmd.startsWith(`gh pr view 10 -R spy4x/example`)) return json(PRS[`10`])
    if (cmd.startsWith(`gh pr list -R spy4x/example`)) {
      const filler = Array.from({ length: options.listed ?? 0 }, (_, i) => ({
        number: 100 + i,
        title: `x`,
        body: ``,
        mergedAt: `2026-08-01T00:00:00Z`, // before the original: never compared
        mergeCommit: null,
      }))
      return json([
        ...filler,
        {
          number: 11,
          title: `fix: header`,
          body: ``,
          mergedAt: `2026-09-03T00:00:00Z`,
          mergeCommit: { oid: `f`.repeat(40) },
        },
      ])
    }
    if (cmd.includes(`repos/spy4x/example/pulls/10/files`)) {
      return json([[{ filename: `src/a.ts`, status: `modified`, patch: ORIGINAL_PATCH }]])
    }
    if (cmd.includes(`repos/spy4x/example/pulls/11/files`)) {
      return json([[{ filename: `src/a.ts`, status: `modified`, patch: OVERLAPPING_PATCH }]])
    }
    if (cmd.includes(`repos/spy4x/example/commits?`)) return json([[]])
    if (cmd.includes(`repos/spy4x/example/issues/7/timeline`)) {
      return json([[
        { event: `closed`, created_at: `2026-09-01T00:00:00Z` },
        { event: `labeled`, created_at: `2026-09-02T00:00:00Z` },
        { event: `reopened`, created_at: `2026-09-06T00:00:00Z` },
        { event: `closed`, created_at: `2026-09-07T00:00:00Z` },
        { event: `commented`, created_at: `2026-09-08T00:00:00Z` },
      ]])
    }
    return Promise.reject(new CommandError(command, args, `unexpected call in test`))
  }
}

const LANES = [laneRow({
  prInfo: {
    "spy4x/example#10": {
      additions: 3,
      deletions: 0,
      state: `MERGED`,
      mergedAt: MERGED,
      createdAt: MERGED,
      title: `feat: add table`,
      headRefName: `feat/t`,
      closingIssues: [7],
    },
  },
})]

t(`collectFollowups reads the fix PR and the reopened issue through gh`, async () => {
  const [row] = await collectFollowups(LANES, AFTER_30, fakeGh())
  assertEquals(row.pr, `spy4x/example#10`)
  assertEquals(done(row.d14).fixes.map((f) => [f.pr, f.fixType]), [[11, true]])
  assertEquals(done(row.d14).reopened, [{ issue: `spy4x/example#7`, at: `2026-09-06T00:00:00Z` }])
})

t(`collectFollowups reads the timeline of a closing issue that lives in another repo`, async () => {
  const gh = fakeGh()
  const [row] = await collectFollowups(LANES, AFTER_30, (command, args) => {
    const cmd = [command, ...args].join(` `)
    if (cmd.startsWith(`gh pr view 10`)) {
      const pr = {
        ...(PRS[`10`] as object),
        closingIssuesReferences: [
          { number: 7, repository: { name: `other`, owner: { login: `spy4x` } } },
        ],
      }
      return Promise.resolve(JSON.stringify(pr))
    }
    if (cmd.includes(`repos/spy4x/example/issues/7/`)) {
      return Promise.reject(new CommandError(command, args, `exit 1: Not Found (HTTP 404)`))
    }
    if (cmd.includes(`repos/spy4x/other/issues/7/timeline`)) {
      return Promise.resolve(
        JSON.stringify([[{ event: `reopened`, created_at: `2026-09-06T00:00:00Z` }]]),
      )
    }
    return gh(command, args)
  })
  assertEquals(done(row.d14).reopened, [{ issue: `spy4x/other#7`, at: `2026-09-06T00:00:00Z` }])
})

t(`collectFollowups looks at the default branch as named now, not the PR's old base`, async () => {
  const calls: string[] = []
  const gh = fakeGh()
  await collectFollowups(LANES, AFTER_30, (command, args) => {
    calls.push([command, ...args].join(` `))
    return gh(command, args)
  })
  assertEquals(calls.some((c) => c.startsWith(`gh pr list`) && c.includes(`--base main`)), true)
  assertEquals(calls.some((c) => c.includes(`/commits?sha=main&`)), true)
})

t(`collectFollowups rejects when a gh call fails instead of reporting no follow-ups`, async () => {
  for (
    const broken of [`gh pr view`, `gh repo view`, `gh pr list`, `/files`, `/commits?`, `/timeline`]
  ) {
    const error = await assertRejects(
      () => collectFollowups(LANES, AFTER_30, fakeGh({ fail: (cmd) => cmd.includes(broken) })),
      CommandError,
    )
    assertStringIncludes(error.message, `exit 1: boom`)
  }
})

t(`collectFollowups rejects when the merged PR list hit the call's limit`, async () => {
  await assertRejects(
    () => collectFollowups(LANES, AFTER_30, fakeGh({ listed: 1000 })),
    CommandError,
    `may be cut short`,
  )
})

t(`the command exits 1 and writes no followups.jsonl when gh fails`, async () => {
  const dir = await Deno.makeTempDir({ prefix: `followup-test-` })
  try {
    await Deno.writeTextFile(
      join(dir, `lanes.jsonl`),
      LANES.map((l) => JSON.stringify(l)).join(`\n`) + `\n`,
    )
    const bin = join(dir, `bin`)
    await Deno.mkdir(bin)
    await Deno.writeTextFile(
      join(bin, `gh`),
      `#!/bin/sh\necho "gh: simulated outage" >&2\nexit 1\n`,
    )
    await Deno.chmod(join(bin, `gh`), 0o755)
    const result = await new Deno.Command(Deno.execPath(), {
      args: [`run`, `-A`, FOLLOWUP, dir, `--now`, `2026-10-01T00:00:00Z`],
      env: { PATH: `${bin}:/usr/bin:/bin` },
      stdout: `piped`,
      stderr: `piped`,
    }).output()
    assertEquals(result.code, 1)
    assertStringIncludes(new TextDecoder().decode(result.stderr), `followup failed`)
    assertEquals(
      await Deno.stat(join(dir, `followups.jsonl`)).then(() => true, () => false),
      false,
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

t(`the command exits 2 on a --now that is not an ISO date`, async () => {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [`run`, `-A`, FOLLOWUP, `/nonexistent`, `--now`, `tomorrow`],
    stdout: `piped`,
    stderr: `piped`,
  }).output()
  assertEquals(result.code, 2)
  assertStringIncludes(new TextDecoder().decode(result.stderr), `--now must be`)
})

t(
  `remapRanges leaves the line directly above an insertion where it is and moves the one below`,
  () => {
    // Five lines inserted after old line 5.
    const blocks = parseBlocks(`@@ -5,0 +6,1 @@\n+x`)
    assertEquals(remapRanges([{ start: 5, end: 5 }], blocks), [{ start: 5, end: 5 }])
    assertEquals(remapRanges([{ start: 6, end: 6 }], blocks), [{ start: 7, end: 7 }])
  },
)

t(`buildRow counts an event exactly 14 days after the merge in the 14 day window`, () => {
  const row = buildRow(
    input({
      laterPrs: [
        later(11, `2026-09-15T00:00:00Z`, { files: file(OVERLAPPING_PATCH) }), // day 14, to the second
        later(12, `2026-09-15T00:00:01Z`, { files: file(DISTANT_PATCH) }),
      ],
      laterCommits: [{
        sha: `d`.repeat(40),
        message: `Revert "feat: add table"`,
        at: `2026-09-15T00:00:00Z`,
      }],
      reopens: [{ issue: `spy4x/example#7`, at: `2026-09-15T00:00:00Z` }],
    }),
    AFTER_30,
  )
  const d14 = done(row.d14)
  assertEquals([d14.fixes.length, d14.reverts.length, d14.reopened.length], [1, 1, 1])
})

t(`buildRow ignores a PR merged before the original: it must not move the original's lines`, () => {
  // PR 9 merged a day before and inserts five lines at the top; if it were applied, PR 11's
  // rewrite of line 11 would no longer touch the original's lines 10-12.
  const row = buildRow(
    input({
      laterPrs: [
        later(9, `2026-08-31T00:00:00Z`, { files: file(INSERT_ABOVE) }),
        later(11, `2026-09-02T00:00:00Z`, { files: file(OVERLAPPING_PATCH) }),
      ],
    }),
    AFTER_30,
  )
  assertEquals(done(row.d14).fixes.map((f) => f.pr), [11])
})

t(`collectFollowups does not fetch files of PRs merged after --now`, async () => {
  const gh = fakeGh()
  const calls: string[] = []
  const exec: Exec = (command, args) => {
    const cmd = [command, ...args].join(` `)
    calls.push(cmd)
    if (cmd.startsWith(`gh pr list`)) {
      return gh(command, args).then((out) =>
        JSON.stringify([
          ...JSON.parse(out),
          { number: 15, title: `x`, body: ``, mergedAt: `2026-09-26T00:00:00Z`, mergeCommit: null },
        ])
      )
    }
    return gh(command, args)
  }
  // Day 20: PR 15 (day 25) has not happened yet.
  const [row] = await collectFollowups(LANES, new Date(`2026-09-21T00:00:00Z`), exec)
  assertEquals(calls.some((c) => c.includes(`pulls/15/files`)), false)
  assertEquals(done(row.d14).fixes.map((f) => f.pr), [11])
  assertEquals(row.d30, `pending`)
})

t(`collectFollowups stops at exactly 1000 merged PRs and goes on at 999`, async () => {
  // fakeGh adds one real PR to `listed` filler PRs.
  await assertRejects(
    () => collectFollowups(LANES, AFTER_30, fakeGh({ listed: 999 })),
    CommandError,
    `may be cut short`,
  )
  const [row] = await collectFollowups(LANES, AFTER_30, fakeGh({ listed: 998 }))
  assertEquals(row.pr, `spy4x/example#10`)
})

t(`the command exits 2 on a --now later than the real clock`, async () => {
  const dir = await Deno.makeTempDir({ prefix: `followup-test-` })
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [`run`, `-A`, FOLLOWUP, dir, `--now`, `2999-01-01T00:00:00Z`],
      stdout: `piped`,
      stderr: `piped`,
    }).output()
    assertEquals(result.code, 2)
    const stderr = new TextDecoder().decode(result.stderr)
    assertStringIncludes(stderr, `is in the future`)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

t(`buildRow counts a direct revert commit in the window it falls in, not an earlier one`, () => {
  const revert = (sha: string, at: string) => ({
    sha: sha.repeat(40),
    message: `Revert "feat: add table"`,
    at,
  })
  const row = buildRow(
    input({
      laterCommits: [
        revert(`d`, `2026-09-21T00:00:00Z`), // day 20
        revert(`e`, `2026-08-30T00:00:00Z`), // before the merge
      ],
    }),
    AFTER_30,
  )
  assertEquals(done(row.d14).reverts, [])
  assertEquals(done(row.d30).reverts.map((r) => r.sha?.[0]), [`d`])
})

t(
  `collectFollowups searches each repo from its earliest merge, so an early PR sees its fix`,
  async () => {
    const gh = fakeGh()
    const searches: string[] = []
    const lanes = [laneRow({
      prInfo: {
        ...LANES[0].prInfo,
        "spy4x/example#20": {
          ...LANES[0].prInfo[`spy4x/example#10`],
          mergedAt: `2026-09-10T00:00:00Z`,
        },
      },
    })]
    const exec: Exec = (command, args) => {
      const cmd = [command, ...args].join(` `)
      if (cmd.startsWith(`gh pr view 20 -R spy4x/example`)) {
        return Promise.resolve(JSON.stringify({
          ...(PRS[`10`] as object),
          title: `feat: second`,
          mergedAt: `2026-09-10T00:00:00Z`,
          mergeCommit: { oid: `9`.repeat(40) },
          closingIssuesReferences: [],
        }))
      }
      if (cmd.includes(`pulls/20/files`)) return Promise.resolve(`[[]]`)
      if (cmd.startsWith(`gh pr list`)) {
        // Honour the search like GitHub does: only PRs merged on or after the given date.
        const since = args[args.indexOf(`--search`) + 1].replace(`merged:>=`, ``)
        searches.push(since)
        return gh(command, args).then((out) =>
          JSON.stringify(
            (JSON.parse(out) as { mergedAt: string }[]).filter((p) =>
              p.mergedAt.slice(0, 10) >= since
            ),
          )
        )
      }
      return gh(command, args)
    }
    const rows = await collectFollowups(lanes, AFTER_30, exec)
    assertEquals(searches, [`2026-09-01`])
    assertEquals(done(rows[0].d14).fixes.map((f) => f.pr), [11])
  },
)

t(`collectFollowups rejects when gh exits 0 but prints something that is not JSON`, async () => {
  for (
    const garbled of [
      `gh pr view`,
      `gh repo view`,
      `gh pr list`,
      `/files`,
      `/commits?`,
      `/timeline`,
    ]
  ) {
    const gh = fakeGh()
    const exec: Exec = (command, args) =>
      [command, ...args].join(` `).includes(garbled)
        ? Promise.resolve(`<html>rate limited</html>`)
        : gh(command, args)
    const error = await assertRejects(() => collectFollowups(LANES, AFTER_30, exec), CommandError)
    assertStringIncludes(error.message, `not JSON`)
  }
})
