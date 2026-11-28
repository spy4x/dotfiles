import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19"
import { fromFileUrl, join } from "jsr:@std/path@^1.0.0"

const SCRIPT = fromFileUrl(new URL(`./woodpecker-api.sh`, import.meta.url))
const TOKEN = `tok-7f3a9c2e1b`

/**
 * A fake `curl` first on PATH: saves its argv (one per line), stdin, environment and a `ps`
 * snapshot taken while it runs next to itself, then exits with the code in `exit-code`, if any.
 */
const FAKE_CURL = `#!/bin/sh
d=$(dirname "$0")
for a in "$@"; do echo "$a"; done >"$d/argv"
cat >"$d/stdin"
env >"$d/env"
ps -eo args >"$d/ps"
[ -f "$d/exit-code" ] && exit "$(cat "$d/exit-code")"
exit 0
`

interface Run {
  code: number
  stderr: string
  /** Reads a file the fake curl wrote, or `undefined` when curl never ran. */
  saved: (name: string) => Promise<string | undefined>
}

/** Runs the helper with only PATH, HOME and `env` set, so the real account env file is unreachable. */
async function helper(
  args: string[],
  env: Record<string, string> | ((dir: string) => Record<string, string>) = {},
  setup?: (dir: string) => Promise<void>,
  body?: (r: Run) => Promise<void>,
) {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(join(dir, `curl`), FAKE_CURL, { mode: 0o755 })
    await setup?.(dir)
    const out = await new Deno.Command(SCRIPT, {
      args,
      clearEnv: true,
      env: {
        PATH: `${dir}:${Deno.env.get(`PATH`)}`,
        HOME: dir,
        ...(typeof env === `function` ? env(dir) : env),
      },
    }).output()
    const saved = (name: string) =>
      Deno.readTextFile(join(dir, name)).catch((e) => {
        if (e instanceof Deno.errors.NotFound) return undefined
        throw e
      })
    await body?.({ code: out.code, stderr: new TextDecoder().decode(out.stderr), saved })
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

/** The token reached curl only on stdin: not in its argv, its environment or any `ps` line. */
async function assertTokenOnlyOnStdin(r: Run, token: string) {
  assertEquals(r.code, 0, r.stderr)
  assertEquals(await r.saved(`stdin`), `Authorization: Bearer ${token}\n`)
  assert(!(await r.saved(`argv`))!.includes(token), `token in curl argv`)
  assert(!(await r.saved(`ps`))!.includes(token), `token in ps snapshot`)
}

Deno.test(`sends the env var token on stdin, never in argv or ps`, () =>
  helper([`user`], { WOODPECKER_CI_TOKEN: TOKEN }, undefined, async (r) => {
    await assertTokenOnlyOnStdin(r, TOKEN)
    assertEquals(
      (await r.saved(`argv`))!.trim().split(`\n`).at(-1),
      `https://ci.antonshubin.com/api/user`,
    )
  }))

/** Writes the account env file at its default place under the fake HOME. */
async function writeEnvFile(home: string, text: string) {
  const dir = join(home, `sync/code/homelab`)
  await Deno.mkdir(dir, { recursive: true })
  await Deno.writeTextFile(join(dir, `.env.accounts`), text)
}

Deno.test(`reads the token from the default env file and strips its quotes`, () =>
  helper(
    [`user`],
    {},
    (dir) => writeEnvFile(dir, `OTHER=1\nWOODPECKER_CI_TOKEN="${TOKEN}"\nLAST=2\n`),
    (r) => assertTokenOnlyOnStdin(r, TOKEN),
  ))

Deno.test(`reads the token from WOODPECKER_ENV_FILE`, () =>
  helper(
    [`user`],
    (dir) => ({ WOODPECKER_ENV_FILE: join(dir, `env-file`) }),
    (dir) => Deno.writeTextFile(join(dir, `env-file`), `WOODPECKER_CI_TOKEN='${TOKEN}'`),
    (r) => assertTokenOnlyOnStdin(r, TOKEN),
  ))

Deno.test(`prefers the env var token over the env file`, () =>
  helper(
    [`user`],
    { WOODPECKER_CI_TOKEN: TOKEN },
    (dir) => writeEnvFile(dir, `WOODPECKER_CI_TOKEN=file-token-x\n`),
    (r) => assertTokenOnlyOnStdin(r, TOKEN),
  ))

Deno.test(`fails naming the variable and never calls curl when no token exists`, () =>
  helper([`user`], { WOODPECKER_ENV_FILE: `/nonexistent/env-file` }, undefined, async (r) => {
    assertEquals(r.code, 1)
    assertStringIncludes(r.stderr, `WOODPECKER_CI_TOKEN`)
    assertStringIncludes(r.stderr, `/nonexistent/env-file`)
    assertEquals(await r.saved(`argv`), undefined)
  }))

Deno.test(`prints usage and exits 2 without a path`, () =>
  helper([], { WOODPECKER_CI_TOKEN: TOKEN }, undefined, async (r) => {
    assertEquals(r.code, 2)
    assertStringIncludes(r.stderr, `usage:`)
    assertEquals(await r.saved(`argv`), undefined)
  }))

Deno.test(`strips a leading /api/ from the path and a trailing slash from the server`, () =>
  helper(
    [`/api/repos/1/pipelines`],
    { WOODPECKER_CI_TOKEN: TOKEN, WOODPECKER_SERVER: `https://ci.example.com/` },
    undefined,
    async (r) => {
      assertEquals(r.code, 0, r.stderr)
      const url = (await r.saved(`argv`))!.trim().split(`\n`).at(-1)
      assertEquals(url, `https://ci.example.com/api/repos/1/pipelines`)
    },
  ))

Deno.test(`passes extra arguments to curl`, () =>
  helper(
    [`repos/1/pipelines/273`, `-X`, `POST`],
    { WOODPECKER_CI_TOKEN: TOKEN },
    undefined,
    async (r) => {
      assertEquals(r.code, 0, r.stderr)
      assertEquals((await r.saved(`argv`))!.trim().split(`\n`), [
        `-fsS`,
        `-H`,
        `@-`,
        `-X`,
        `POST`,
        `https://ci.antonshubin.com/api/repos/1/pipelines/273`,
      ])
    },
  ))

Deno.test(`exits with curl's exit code`, () =>
  helper(
    [`user`],
    { WOODPECKER_CI_TOKEN: TOKEN },
    (dir) => Deno.writeTextFile(join(dir, `exit-code`), `22`),
    async (r) => assertEquals(r.code, 22),
  ))

Deno.test(`keeps the token out of curl's environment`, () =>
  helper([`user`], { WOODPECKER_CI_TOKEN: TOKEN }, undefined, async (r) => {
    assertEquals(r.code, 0, r.stderr)
    const env = (await r.saved(`env`))!
    assert(!env.includes(TOKEN), `token in curl env`)
    assert(!env.includes(`WOODPECKER_CI_TOKEN`), `token variable in curl env`)
  }))
