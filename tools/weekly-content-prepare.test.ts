import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19"
import { fromFileUrl, join } from "jsr:@std/path@^1.0.0"

const SCRIPT = fromFileUrl(new URL(`./weekly-content-prepare.sh`, import.meta.url))
const BRIEF = fromFileUrl(new URL(`./weekly-content-prepare.md`, import.meta.url))
const ROOT = await Deno.makeTempDir({ prefix: `weekly-content-prepare-` })
globalThis.addEventListener(`unload`, () => Deno.removeSync(ROOT, { recursive: true }))
const WEEK = `2026-W48`
const TURN = `1. Seed, now.\n2. The owner's blog, once antonshubin.com runs on Seed.\n`

interface Case {
  /** The weekly-content skill's text. */
  skill?: string
  /** The pressure file's text; `null` leaves the file out. */
  pressure?: string | null
  /** What the fake `agent-run limit` prints. */
  limits?: string
  /** The fake `agent-run start` exit code. */
  startExit?: number
  /** Whether this week's marker exists before the run. */
  marked?: boolean
  /** Whether the project folder `<code>/seed` exists. */
  project?: boolean
}

/**
 * Runs the script in a fresh folder with a fake `agent-run` first on PATH that logs each call's
 * arguments, one line per call, to `calls`.
 */
async function prepare(c: Case) {
  const dir = await Deno.makeTempDir({ dir: ROOT })
  const bin = join(dir, `bin`)
  const state = join(dir, `state`)
  await Deno.mkdir(bin)
  await Deno.mkdir(join(dir, `code`))
  if (c.project ?? true) await Deno.mkdir(join(dir, `code`, `seed`))
  if (c.marked) {
    await Deno.mkdir(state)
    await Deno.writeTextFile(join(state, WEEK), `earlier\n`)
  }
  await Deno.writeTextFile(join(dir, `skill.md`), c.skill ?? TURN)
  if (c.pressure !== null) {
    await Deno.writeTextFile(
      join(dir, `pressure`),
      c.pressure ?? `some avg10=6.76 avg60=4.58 avg300=16.77 total=1\nfull avg10=0 avg60=0\n`,
    )
  }
  await Deno.writeTextFile(join(dir, `limits`), c.limits ?? `seed: 0 of 0 lead runs\n`)
  await Deno.writeTextFile(
    join(bin, `agent-run`),
    `#!/bin/sh\necho "$*" >>"${dir}/calls"\n` +
      `[ "$1 $#" = "limit 1" ] && cat "${dir}/limits"\n` +
      `[ "$1" = start ] && exit ${c.startExit ?? 0}\nexit 0\n`,
    { mode: 0o755 },
  )
  const out = await new Deno.Command(SCRIPT, {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      AGENT_RUN: `agent-run`,
      WEEKLY_CONTENT_STATE: state,
      WEEKLY_CONTENT_SKILL: join(dir, `skill.md`),
      WEEKLY_CONTENT_CODE: join(dir, `code`),
      WEEKLY_CONTENT_PRESSURE: join(dir, `pressure`),
      WEEKLY_CONTENT_WEEK: WEEK,
    },
    stdout: `piped`,
    stderr: `piped`,
  }).output()
  const calls = await Deno.readTextFile(join(dir, `calls`)).catch(() => ``)
  return {
    dir,
    code: out.code,
    output: new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr),
    calls: calls.split(`\n`).filter(Boolean),
    marked: await Deno.stat(join(state, WEEK)).then(() => true, () => false),
  }
}

const starts = (calls: string[]) => calls.filter((c) => c.startsWith(`start `))
const raises = (calls: string[]) => calls.filter((c) => c.includes(`--leads`))

Deno.test(`does nothing when this week's kit run already started`, async () => {
  const r = await prepare({ marked: true })
  assertEquals([r.code, r.calls], [0, []])
})

Deno.test(`holds without a marker while the user CPU pressure is above 40`, async () => {
  const r = await prepare({ pressure: `some avg10=90.00 avg60=41.20 avg300=30.00 total=1\n` })
  assertEquals([r.code, r.calls, r.marked], [0, [], false])
  assertStringIncludes(r.output, `avg60=41.20`)
})

Deno.test(`carries on when the pressure file is missing`, async () => {
  const r = await prepare({ pressure: null })
  assertEquals([r.code, starts(r.calls).length, r.marked], [0, 1, true])
})

Deno.test(`fails clearly when the skill names no project on turn`, async () => {
  const r = await prepare({ skill: `1. Seed, later.\n` })
  assertEquals([r.code, r.calls, r.marked], [1, [], false])
  assertStringIncludes(r.output, `cannot tell whose turn it is`)
})

Deno.test(`fails clearly when the project on turn has no folder`, async () => {
  const r = await prepare({ project: false })
  assertEquals([r.code, r.calls, r.marked], [1, [], false])
  assertStringIncludes(r.output, `has no folder`)
})

Deno.test(`raises a lead limit of 0 to 1 before starting`, async () => {
  const r = await prepare({ limits: `antonshubin.com: 0 of 3 lead runs\nseed: 0 of 0 lead runs\n` })
  assertEquals(r.calls.slice(0, 2), [`limit`, `limit --project seed --leads 1`])
  assertEquals(starts(r.calls).length, 1)
  assert(r.calls.indexOf(raises(r.calls)[0]) < r.calls.indexOf(starts(r.calls)[0]))
})

Deno.test(`never changes a lead limit that is already 1 or more`, async () => {
  for (const limit of [1, 4]) {
    const r = await prepare({ limits: `seed: 0 of ${limit} lead runs\n` })
    assertEquals([r.code, raises(r.calls), starts(r.calls).length], [0, [], 1])
  }
})

Deno.test(`writes no marker when agent-run refuses the start`, async () => {
  const r = await prepare({ startExit: 2 })
  assertEquals([r.code === 0, starts(r.calls).length, r.marked], [false, 1, false])
})

Deno.test(`starts the week's lead and marks the week once it started`, async () => {
  const r = await prepare({})
  assertEquals([r.code, r.marked], [0, true])
  assertEquals(starts(r.calls), [
    `start --cwd ${r.dir}/code/seed --model opus --effort medium --mode lead ` +
    `--name weekly-content-${WEEK} --deadline 2h --budget-usd 20 --brief ${BRIEF}`,
  ])
})
