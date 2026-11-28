import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.19"
import { fromFileUrl, join } from "jsr:@std/path@^1.0.0"

const SCRIPT = fromFileUrl(new URL(`./ship.sh`, import.meta.url))
const URL_1 = `https://github.com/example/repo/pull/1`

/**
 * A fake `gh` first on PATH: logs each call to `calls`, copies a `--body-file` into `body`, and
 * answers `pr view` from `pr-url`, which `pr create` fills. The real `gh` is never reached.
 */
const FAKE_GH = `#!/bin/sh
d=$FAKE_GH_DIR
echo "$*" >>"$d/calls"
case "$1 $2" in
  "pr view") [ -s "$d/pr-url" ] && cat "$d/pr-url" ;;
  "pr create")
    while [ $# -gt 0 ]; do
      [ "$1" = --body-file ] && cat "$2" >"$d/body"
      shift
    done
    echo "${URL_1}" >"$d/pr-url"
    cat "$d/pr-url"
    ;;
  *) exit 1 ;;
esac
`

/** Git without the machine's global config, so hooks paths or signing never leak into a test. */
const GIT_ENV = { GIT_CONFIG_GLOBAL: `/dev/null`, GIT_CONFIG_NOSYSTEM: `1` }

interface Result {
  code: number
  stdout: string
  stderr: string
}

async function run(cmd: string, args: string[], cwd: string, env = {}): Promise<Result> {
  const out = await new Deno.Command(cmd, { args, cwd, env: { ...GIT_ENV, ...env } }).output()
  const dec = new TextDecoder()
  return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await run(`git`, args, cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(` `)}: ${r.stderr}`)
  return r.stdout.trim()
}

interface Repo {
  root: string
  work: string
  ship: (...args: string[]) => Promise<Result>
  calls: () => Promise<string[]>
  write: (path: string, text: string) => Promise<void>
}

/**
 * A temp clone on branch `feat/x` with tracked `a.txt` and `b.txt`, a local bare `origin`, and the
 * fake `gh`. `prUrl` pre-fills an existing PR. Removed after `body`.
 */
async function withRepo(body: (r: Repo) => Promise<void>, prUrl = ``): Promise<void> {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: `ship-test-` }))
  try {
    const work = join(root, `work`)
    await Deno.mkdir(join(root, `bin`))
    await Deno.mkdir(join(root, `gh`))
    await Deno.writeTextFile(join(root, `bin`, `gh`), FAKE_GH, { mode: 0o755 })
    await Deno.writeTextFile(join(root, `gh`, `pr-url`), prUrl)
    await git(root, `init`, `-q`, `--bare`, `-b`, `main`, `remote.git`)
    await git(root, `init`, `-q`, `-b`, `main`, `work`)
    await git(work, `config`, `user.name`, `Test`)
    await git(work, `config`, `user.email`, `test@example.com`)
    await git(work, `remote`, `add`, `origin`, join(root, `remote.git`))
    const write = (path: string, text: string) => Deno.writeTextFile(join(work, path), text)
    await write(`a.txt`, `a\n`)
    await write(`b.txt`, `b\n`)
    await git(work, `add`, `.`)
    await git(work, `commit`, `-q`, `-m`, `init`)
    await git(work, `push`, `-q`, `origin`, `main`)
    await git(work, `checkout`, `-q`, `-b`, `feat/x`)
    const env = {
      PATH: `${join(root, `bin`)}:${Deno.env.get(`PATH`)}`,
      FAKE_GH_DIR: join(root, `gh`),
    }
    await body({
      root,
      work,
      write,
      ship: (...args) => run(`bash`, [SCRIPT, ...args], work, env),
      calls: async () => {
        const text = await Deno.readTextFile(join(root, `gh`, `calls`)).catch(() => ``)
        return text.split(`\n`).filter(Boolean)
      },
    })
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

/** The files the branch's commits changed against `main`, and how many commits it has. */
async function branchChanges(work: string): Promise<{ files: string[]; commits: number }> {
  const files = (await git(work, `diff`, `--name-only`, `main..HEAD`)).split(`\n`).filter(Boolean)
  const commits = Number(await git(work, `rev-list`, `--count`, `main..HEAD`))
  return { files, commits }
}

async function hook(work: string, script: string): Promise<void> {
  await Deno.writeTextFile(join(work, `.git`, `hooks`, `pre-push`), `#!/bin/sh\n${script}`, {
    mode: 0o755,
  })
}

async function shipCheck(dir: string, log: string, script: string): Promise<Result> {
  return await run(`bash`, [SCRIPT, `check`, log, `bash`, `-c`, script], dir)
}

Deno.test(`check prints exit 0 and the summary lines, with NO_COLOR set, on success`, async () => {
  const dir = await Deno.makeTempDir({ prefix: `ship-check-` })
  try {
    const log = join(dir, `nested`, `check.log`)
    const r = await shipCheck(
      dir,
      log,
      `echo noise; echo one; echo two; echo "summary NO_COLOR=$NO_COLOR"`,
    )
    assertEquals(r.code, 0)
    assertEquals(r.stdout, `exit 0\none\ntwo\nsummary NO_COLOR=1\nlog: ${log}\n`)
    assertStringIncludes(await Deno.readTextFile(log), `noise`)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test(`check prints only the failing lines and keeps the command's exit code`, async () => {
  const dir = await Deno.makeTempDir({ prefix: `ship-check-` })
  try {
    const log = join(dir, `check.log`)
    const r = await shipCheck(
      dir,
      log,
      `echo noise; echo "FAIL one"; echo noise; echo "error: two" >&2; echo noise; exit 3`,
    )
    assertEquals(r.code, 3)
    assertEquals(r.stdout, `exit 3\nfailing lines: 2\n2:FAIL one\n4:error: two\nlog: ${log}\n`)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test(`check prints the last 40 lines when a failure matches no pattern`, async () => {
  const dir = await Deno.makeTempDir({ prefix: `ship-check-` })
  try {
    const r = await shipCheck(
      dir,
      join(dir, `c.log`),
      `for i in $(seq 1 50); do echo "l$i"; done; exit 1`,
    )
    assertEquals(r.code, 1)
    const lines = r.stdout.split(`\n`)
    assert(lines.includes(`l11`) && lines.includes(`l50`), r.stdout)
    assert(!lines.includes(`l10`), r.stdout)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test(`pr commits modified tracked files only and names untracked ones`, async () => {
  await withRepo(async ({ work, ship, write }) => {
    await write(`a.txt`, `changed\n`)
    await write(`new.txt`, `new\n`)
    const r = await ship(`pr`, `feat: x`)
    assertEquals(r.code, 0, r.stdout + r.stderr)
    assertStringIncludes(r.stdout, `untracked, not committed: 1\nnew.txt\n`)
    assertEquals(await branchChanges(work), { files: [`a.txt`], commits: 1 })
    assertEquals(await git(work, `status`, `--porcelain`), `?? new.txt`)
  })
})

Deno.test(`pr with explicit paths commits only those paths`, async () => {
  await withRepo(async ({ work, ship, write }) => {
    await write(`a.txt`, `changed\n`)
    await write(`b.txt`, `changed\n`)
    const r = await ship(`pr`, `feat: x`, `b.txt`)
    assertEquals(r.code, 0, r.stdout + r.stderr)
    assertEquals(await branchChanges(work), { files: [`b.txt`], commits: 1 })
    assertEquals(await git(work, `status`, `--porcelain`), `M a.txt`)
  })
})

Deno.test(`pr run twice makes one commit and still prints the PR URL`, async () => {
  await withRepo(async ({ work, ship, write }) => {
    await write(`a.txt`, `changed\n`)
    assertEquals((await ship(`pr`, `feat: x`)).code, 0)
    const r = await ship(`pr`, `feat: x`)
    assertEquals(r.code, 0, r.stdout + r.stderr)
    assertEquals(r.stdout, `nothing to commit\npushed feat/x\nPR: ${URL_1}\n`)
    assertEquals((await branchChanges(work)).commits, 1)
  })
})

Deno.test(`pr creates a WIP PR whose body starts with the agent marker`, async () => {
  await withRepo(async ({ root, work, ship, write, calls }) => {
    await write(`a.txt`, `changed\n`)
    const r = await ship(`pr`, `feat: x`)
    assertEquals(r.code, 0, r.stdout + r.stderr)
    const sha = await git(work, `rev-parse`, `--short`, `HEAD`)
    assertEquals(r.stdout, `committed ${sha} feat: x\npushed feat/x\nPR: ${URL_1}\n`)
    assertEquals(
      await git(join(root, `remote.git`), `rev-parse`, `feat/x`),
      await git(work, `rev-parse`, `HEAD`),
    )
    const create = (await calls()).filter((c) => c.startsWith(`pr create`))
    assertEquals(create.length, 1)
    assert(create[0].startsWith(`pr create --title [WIP] feat: x --body-file `), create[0])
    const body = await Deno.readTextFile(join(root, `gh`, `body`))
    assertEquals(body.split(`\n`)[0], `<!-- agent -->`)
  })
})

Deno.test(`pr with an existing PR prints its URL and creates none`, async () => {
  const existing = `https://github.com/example/repo/pull/7`
  await withRepo(async ({ ship, write, calls }) => {
    await write(`a.txt`, `changed\n`)
    const r = await ship(`pr`, `feat: x`)
    assertEquals(r.code, 0, r.stdout + r.stderr)
    assertStringIncludes(r.stdout, `PR: ${existing}\n`)
    assert(!(await calls()).some((c) => c.startsWith(`pr create`)))
  }, existing)
})

Deno.test(`pr stops with the failing lines and no gh call when the pre-push hook fails`, async () => {
  await withRepo(async ({ work, ship, write, calls }) => {
    await hook(work, `echo noise; echo "FAIL: check broke"; exit 1\n`)
    await write(`a.txt`, `changed\n`)
    const r = await ship(`pr`, `feat: x`)
    assert(r.code !== 0)
    assertStringIncludes(r.stdout, `exit 1\n`)
    assertStringIncludes(r.stdout, `FAIL: check broke`)
    assert(!r.stdout.includes(`pushed`), r.stdout)
    assertEquals(await calls(), [])
  })
})

Deno.test(`pr pushes with CI=true and a throwaway DENO_DIR removed afterwards`, async () => {
  await withRepo(async ({ root, work, ship, write }) => {
    const seen = join(root, `seen`)
    await hook(work, `[ -d "$DENO_DIR" ] && echo "$CI $DENO_DIR" >"${seen}"\n`)
    await write(`a.txt`, `changed\n`)
    assertEquals((await ship(`pr`, `feat: x`)).code, 0)
    const [ci, denoDir] = (await Deno.readTextFile(seen)).trim().split(` `)
    assertEquals(ci, `true`)
    await assertRejects(() => Deno.stat(denoDir), Deno.errors.NotFound)
  })
})

Deno.test(`bad arguments exit 2 with usage`, async () => {
  for (const args of [[], [`nope`], [`check`, `only.log`], [`pr`], [`pr`, ``]]) {
    const r = await run(`bash`, [SCRIPT, ...args], Deno.cwd())
    assertEquals(r.code, 2, args.join(` `))
    assertStringIncludes(r.stderr, `usage: ship.sh check`)
  }
})
