import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19"
import { join } from "node:path"
import {
  evaluate,
  isInside,
  parseGh,
  parseGit,
  splitCommands,
  stripWrappers,
  toSegments,
  worktreeAddPath,
} from "./guard-git.ts"

async function sh(cwd: string, ...args: string[]): Promise<void> {
  const env = { GIT_CONFIG_GLOBAL: `/dev/null`, GIT_CONFIG_SYSTEM: `/dev/null` }
  const out = await new Deno.Command(args[0], { args: args.slice(1), cwd, env, stderr: `piped` })
    .output()
  if (out.code !== 0) throw new Error(`${args.join(` `)}: ${new TextDecoder().decode(out.stderr)}`)
}

/** Temp repo on `main` with one commit and a bare `origin` that already has it. */
async function makeRepo(): Promise<{ root: string; repo: string; cleanup: () => Promise<void> }> {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: `guard-git-` }))
  const repo = join(root, `repo`)
  await Deno.mkdir(repo)
  await sh(repo, `git`, `init`, `-q`, `-b`, `main`)
  await sh(repo, `git`, `config`, `user.email`, `test@example.com`)
  await sh(repo, `git`, `config`, `user.name`, `Test`)
  await Deno.writeTextFile(join(repo, `a.txt`), `a\n`)
  await sh(repo, `git`, `add`, `.`)
  await sh(repo, `git`, `commit`, `-q`, `-m`, `init`)
  await sh(root, `git`, `init`, `-q`, `--bare`, `origin.git`)
  await sh(repo, `git`, `remote`, `add`, `origin`, join(root, `origin.git`))
  await sh(repo, `git`, `push`, `-q`, `origin`, `main`)
  return { root, repo, cleanup: () => Deno.remove(root, { recursive: true }) }
}

/** Executable that records its args + stdin and exits with `code`, standing in for gitleaks. */
async function stubGitleaks(dir: string, code: number, stdout = ``): Promise<string> {
  const path = join(dir, `gitleaks-stub-${code}`)
  const body =
    `#!/bin/sh\necho "$@" > "${path}.args"\ncat > "${path}.stdin"\nprintf '%s' '${stdout}'\n` +
    `echo boom >&2\nexit ${code}\n`
  await Deno.writeTextFile(path, body, { mode: 0o755 })
  return path
}

Deno.test(`splitCommands keeps separators inside quotes in one command`, () => {
  assertEquals(splitCommands(`git commit -m "fix: a; b && c" && git push`), [
    [`git`, `commit`, `-m`, `fix: a; b && c`],
    [`git`, `push`],
  ])
  assertEquals(splitCommands(`echo 'it''s' | cat\nls`), [[`echo`, `its`], [`cat`], [`ls`]])
  // a substitution runs even inside double quotes, so its body is surfaced as a command
  assertEquals(splitCommands(`echo "$(git push)"`), [[`git`, `push`], [`echo`, `$()`]])
  assertEquals(splitCommands("echo `git push`"), [[`git`, `push`], [`echo`, `$()`]])
  assertEquals(splitCommands(`echo '$(git push)'`), [[`echo`, `$(git push)`]])
})

Deno.test(`stripWrappers drops env assignments and exec wrappers`, () => {
  assertEquals(stripWrappers([`FOO=1`, `timeout`, `-k`, `5`, `30`, `git`, `push`]), [`git`, `push`])
  assertEquals(stripWrappers([`command`, `git`, `status`]), [`git`, `status`])
})

Deno.test(`toSegments follows cd hops`, () => {
  const segments = toSegments(`cd sub && git status; cd /abs && gh pr view`, `/work`)
  assertEquals(segments.map((s) => s.cwd), [`/work/sub`, `/abs`])
})

Deno.test(`parseGit finds the subcommand behind global options`, () => {
  const call = parseGit({
    argv: [`git`, `-c`, `a.b=c`, `-C`, `../x`, `push`, `origin`],
    cwd: `/work/y`,
  })
  assertEquals(call, { dir: `/work/x`, subcommand: `push`, args: [`origin`] })
  assertEquals(parseGit({ argv: [`/usr/bin/git`, `commit`], cwd: `/w` })?.subcommand, `commit`)
  assertEquals(parseGit({ argv: [`gitk`], cwd: `/w` }), null)
})

Deno.test(`parseGh skips flags and the -R value`, () => {
  assertEquals(parseGh({ argv: [`gh`, `-R`, `o/r`, `pr`, `merge`, `5`, `--squash`], cwd: `/w` }), [
    `pr`,
    `merge`,
  ])
})

Deno.test(`worktreeAddPath skips option values`, () => {
  assertEquals(worktreeAddPath([`add`, `-b`, `feat/x`, `../wt/x`, `origin/main`]), `../wt/x`)
  assertEquals(worktreeAddPath([`list`]), null)
})

Deno.test(`isInside treats a sibling with a shared prefix as outside`, () => {
  assertEquals(isInside(`/a/repo/sub`, `/a/repo`), true)
  assertEquals(isInside(`/a/repo`, `/a/repo`), true)
  assertEquals(isInside(`/a/repo-2`, `/a/repo`), false)
})

Deno.test(`asks before a commit on main, stays silent on a feature branch`, async () => {
  const { repo, cleanup } = await makeRepo()
  try {
    assertEquals((await evaluate(`git add -A && git commit -m "x; y"`, repo))?.verdict, `ask`)
    assertEquals((await evaluate(`git -C ${repo} commit -m x`, `/`))?.verdict, `ask`)
    assertEquals(await evaluate(`git commit --dry-run`, repo), null)
    await sh(repo, `git`, `checkout`, `-q`, `-b`, `feat/x`)
    assertEquals(await evaluate(`git commit -m x`, repo), null)
  } finally {
    await cleanup()
  }
})

Deno.test(`denies a worktree inside the checkout, allows the sibling layout`, async () => {
  const { root, repo, cleanup } = await makeRepo()
  try {
    const nested = await evaluate(`git worktree add -b feat/x feat/x origin/main`, repo)
    assertEquals(nested?.verdict, `deny`)
    assertStringIncludes(nested?.reason ?? ``, `${root}/worktrees/repo/<type>/<slug>`)
    assertEquals(await evaluate(`git worktree add -b feat/x ../worktrees/repo/feat/x`, repo), null)
    assertEquals(await evaluate(`git worktree add "$WT" origin/main`, repo), null)
  } finally {
    await cleanup()
  }
})

Deno.test(`always asks on gh pr merge`, async () => {
  assertEquals(
    (await evaluate(`gh -R o/r pr merge 5 --squash --delete-branch`, `/`))?.verdict,
    `ask`,
  )
  assertEquals(await evaluate(`gh pr view 5`, `/`), null)
})

Deno.test(`push: scans only when commits are unpushed, denies on a finding`, async () => {
  const { root, repo, cleanup } = await makeRepo()
  try {
    const leaky = await stubGitleaks(root, 3, `RuleID:      aws-access-token\nFile:        a.txt\n`)
    assertEquals(await evaluate(`git push`, repo, { gitleaks: leaky }), null) // nothing unpushed
    await Deno.writeTextFile(join(repo, `a.txt`), `b\n`)
    await sh(repo, `git`, `commit`, `-qam`, `change`)
    const finding = await evaluate(`git push`, repo, { gitleaks: leaky })
    assertEquals(finding?.verdict, `deny`)
    assertStringIncludes(finding?.reason ?? ``, `aws-access-token`)
    assertStringIncludes(
      await Deno.readTextFile(`${leaky}.args`),
      `--log-opts=HEAD --not --remotes`,
    )
    assertEquals(await evaluate(`git push`, repo, { gitleaks: await stubGitleaks(root, 0) }), null)
  } finally {
    await cleanup()
  }
})

Deno.test(`gh body: pipes command text and --body-file to the scanner`, async () => {
  const { root, cleanup } = await makeRepo()
  try {
    await Deno.writeTextFile(join(root, `body.md`), `FILE-BODY-MARKER`)
    const clean = await stubGitleaks(root, 0)
    assertEquals(
      await evaluate(`gh pr create --title t --body-file body.md`, root, { gitleaks: clean }),
      null,
    )
    const piped = await Deno.readTextFile(`${clean}.stdin`)
    assertStringIncludes(piped, `--title t`)
    assertStringIncludes(piped, `FILE-BODY-MARKER`)
  } finally {
    await cleanup()
  }
})

Deno.test(`scanner crash fails closed with an ask; missing scanner stays silent`, async () => {
  const { root, cleanup } = await makeRepo()
  try {
    const broken = await evaluate(`gh issue create --body x`, root, {
      gitleaks: await stubGitleaks(root, 1),
    })
    assertEquals(broken?.verdict, `ask`)
    assertStringIncludes(broken?.reason ?? ``, `boom`)
    assertEquals(
      await evaluate(`gh issue create --body x`, root, { gitleaks: join(root, `absent`) }),
      null,
    )
  } finally {
    await cleanup()
  }
})
