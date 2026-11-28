// Runs the harness-rules mod's gh shim through `sh` with a fake gitleaks and a fake gh on PATH.
// CI has neither tool, and the real gh must never post from a test. It lives outside the mod
// because `claude plugin test` loads every `*.test.ts` under a mod with its own kit only.
import { withGhShim } from "./settings/claude/mods/harness-rules/hooks/rules.ts"
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19"
import { fromFileUrl } from "jsr:@std/path@^1.0.0"

/** The directory that holds the shim, as the hook puts it on PATH. */
const SHIM_DIR = fromFileUrl(new URL(`settings/claude/mods/harness-rules/bin`, import.meta.url))

/** Flags a scan whose input holds SECRETX; `GITLEAKS_EXIT` forces another exit code. */
const FAKE_GITLEAKS = `#!/bin/sh
echo call >> "$LOG_DIR/gitleaks.calls"
input=$(cat)
[ -n "$GITLEAKS_EXIT" ] && exit "$GITLEAKS_EXIT"
case $input in *SECRETX*) exit 1 ;; esac
exit 0
`

/** Records its arguments, one per line, and its standard input; refuses to run nested. */
const FAKE_GH = `#!/bin/sh
[ -n "$FAKE_GH_DEPTH" ] && exit 99
export FAKE_GH_DEPTH=1
printf '%s\\n' "$@" > "$LOG_DIR/gh.args"
cat > "$LOG_DIR/gh.stdin"
`

interface Run {
  code: number
  stderr: string
  /** The fake gh's arguments, one per line; undefined when it never ran. */
  ghArgs?: string
  ghStdin?: string
  gitleaksCalls: number
}

interface Options {
  /** Leave the fake gitleaks off PATH. */
  noGitleaks?: boolean
  /** Leave the fake gh off PATH. */
  noGh?: boolean
  gitleaksExit?: number
  stdin?: string
  /** PATH entries before the rest, instead of the shim directory once. */
  front?: string[]
}

/** Each test's own folder: `fakes/` for the two fakes, `tools/` for cat and xargs, its files. */
async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.mkdir(`${dir}/fakes`)
    await Deno.mkdir(`${dir}/tools`)
    // Only cat and xargs beside the fakes, so this machine's own gh and gitleaks stay off PATH.
    for (const tool of [`cat`, `xargs`]) {
      await Deno.symlink(`/usr/bin/${tool}`, `${dir}/tools/${tool}`)
    }
    for (const [name, text] of [[`gitleaks`, FAKE_GITLEAKS], [`gh`, FAKE_GH]]) {
      await Deno.writeTextFile(`${dir}/fakes/${name}`, text, { mode: 0o755 })
    }
    await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

/** Runs `script` with `sh -c` in `dir`, PATH holding the shim, the fakes and cat. */
async function run(dir: string, script: string, options: Options = {}): Promise<Run> {
  const fakes = `${dir}/fakes`
  if (options.noGitleaks) await Deno.remove(`${fakes}/gitleaks`)
  if (options.noGh) await Deno.remove(`${fakes}/gh`)
  const path = [...(options.front ?? [SHIM_DIR]), fakes, `${dir}/tools`].join(`:`)
  const child = new Deno.Command(`/bin/sh`, {
    args: [`-c`, script],
    cwd: dir,
    clearEnv: true,
    env: {
      PATH: path,
      LOG_DIR: dir,
      T: dir,
      ...(options.gitleaksExit === undefined ? {} : { GITLEAKS_EXIT: `${options.gitleaksExit}` }),
    },
    stdin: `piped`,
    stdout: `null`,
    stderr: `piped`,
  }).spawn()
  const writer = child.stdin.getWriter()
  await writer.write(new TextEncoder().encode(options.stdin ?? ``))
  await writer.close()
  const done = await child.output()
  const read = (name: string) => Deno.readTextFile(`${dir}/${name}`).catch(() => undefined)
  const calls = await read(`gitleaks.calls`)
  return {
    code: done.code,
    stderr: new TextDecoder().decode(done.stderr),
    ghArgs: await read(`gh.args`),
    ghStdin: await read(`gh.stdin`),
    gitleaksCalls: calls === undefined ? 0 : calls.trim().split(`\n`).length,
  }
}

/** Writes the test's files: `.env` holds the secret, `t.txt` a title made of it. */
async function secrets(dir: string): Promise<void> {
  await Deno.writeTextFile(`${dir}/.env`, `TOKEN=SECRETX\n`)
  await Deno.writeTextFile(`${dir}/t.txt`, `SECRETX`)
}

/** Asserts the shim refused: a non-zero exit, and the fake gh never ran. */
function refused(result: Run, says: string): void {
  assertEquals(result.code === 0, false, `exit ${result.code}: ${result.stderr}`)
  assertEquals(result.ghArgs, undefined)
  assertStringIncludes(result.stderr, says)
}

const LEAK = `gitleaks found a secret in what this gh post would send`

for (
  const [name, command, stdin] of [
    [
      `a body file the command builds from .env`,
      `printf '<!-- agent -->\\n' > $T/b.md && cat $T/.env >> $T/b.md && gh issue comment 1 --body-file $T/b.md`,
    ],
    [
      `an inline body filled by $(cat .env)`,
      `gh issue comment 1 --body "<!-- agent --> $(cat $T/.env)"`,
    ],
    [`a title read from a file`, `gh pr edit 1 --title "$(cat $T/t.txt)"`],
    [`a title passed through xargs`, `echo SECRETX | xargs gh pr edit 1 -t`],
    [`a body read from standard input`, `gh issue comment 1 --body-file - < $T/.env`],
    [
      `a body piped into --body-file -`,
      `gh issue comment 1 --body-file -`,
      `<!-- agent -->\nSECRETX\n`,
    ],
  ]
) {
  Deno.test(`refuses ${name} when it holds a secret, through the hook's rewrite`, async () => {
    await withDir(async (dir) => {
      await secrets(dir)
      refused(await run(dir, withGhShim(command, SHIM_DIR), { stdin }), LEAK)
    })
  })
}

Deno.test(`reads body files named by -F, -F=, an attached -F and --body-file=`, async () => {
  await withDir(async (dir) => {
    await secrets(dir)
    for (const flag of [`-F .env`, `-F=.env`, `-F.env`, `--body-file=.env`]) {
      refused(await run(dir, `gh pr comment 1 ${flag}`), LEAK)
    }
  })
})

Deno.test(`passes a clean post to gh with the same arguments and standard input`, async () => {
  await withDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/b.md`, `<!-- agent -->\nclean\n`)
    const plain = await run(dir, `gh issue comment 1 --body "two  spaces" -F b.md`)
    assertEquals(plain.code, 0, plain.stderr)
    assertEquals(plain.ghArgs, `issue\ncomment\n1\n--body\ntwo  spaces\n-F\nb.md\n`)
    assertEquals(plain.gitleaksCalls, 1)
  })
  await withDir(async (dir) => {
    const body = `<!-- agent -->\nclean\n\n`
    const piped = await run(dir, `gh pr comment 1 --body-file -`, { stdin: body })
    assertEquals(piped.code, 0, piped.stderr)
    assertEquals(piped.ghStdin, body)
  })
})

Deno.test(`passes other nouns and read-only verbs to gh untouched, without a scan`, async () => {
  await withDir(async (dir) => {
    for (
      const command of [`gh pr view 1`, `gh api repos/a/b -f body=SECRETX`, `gh -R a/b issue list`]
    ) {
      const result = await run(dir, command, { stdin: `kept` })
      assertEquals(result.code, 0, result.stderr)
      assertEquals(result.ghArgs, command.slice(3).split(` `).join(`\n`) + `\n`)
      assertEquals(result.ghStdin, `kept`)
    }
    assertEquals((await run(dir, `true`)).gitleaksCalls, 0)
  })
})

Deno.test(`scans a post whose noun follows global repo flags`, async () => {
  await withDir(async (dir) => {
    for (const repo of [`-R a/b`, `--repo a/b`, `--repo=a/b`, `-Ra/b`]) {
      refused(await run(dir, `gh ${repo} issue comment 1 -b SECRETX`), LEAK)
    }
  })
})

Deno.test(`refuses a post when gitleaks is missing or fails`, async () => {
  await withDir(async (dir) => {
    refused(await run(dir, `gh pr comment 1 -b x`, { gitleaksExit: 2 }), `check failed (exit 2`)
  })
  await withDir(async (dir) => {
    refused(await run(dir, `gh pr comment 1 -b x`, { noGitleaks: true }), `check failed (exit 127`)
  })
})

Deno.test(`refuses a post whose body file it cannot read`, async () => {
  await withDir(async (dir) => {
    refused(await run(dir, `gh pr comment 1 --body-file missing.md`), `cannot read the body file`)
  })
})

Deno.test(`finds the real gh when the shim's directory is on PATH twice`, async () => {
  await withDir(async (dir) => {
    const result = await run(dir, `gh pr comment 1 -b x`, { front: [SHIM_DIR, SHIM_DIR] })
    assertEquals(result.code, 0, result.stderr)
    assertEquals(result.ghArgs, `pr\ncomment\n1\n-b\nx\n`)
  })
})

Deno.test(`exits 127 when no real gh is on PATH`, async () => {
  await withDir(async (dir) => {
    const result = await run(dir, `gh pr view 1`, { noGh: true })
    assertEquals(result.code, 127)
    assertStringIncludes(result.stderr, `no gh found`)
  })
})
