import { assert, assertEquals } from "jsr:@std/assert@1.0.19"
import { dirname, fromFileUrl, join } from "jsr:@std/path@^1.0.0"

const SCRIPT = fromFileUrl(new URL(`./work-backup.sh`, import.meta.url))
const PASSWORD = `test-password`
/** Git without this machine's config, so hooks, signing or a default branch cannot vary a run. */
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: `/dev/null`,
  GIT_CONFIG_NOSYSTEM: `1`,
  GIT_AUTHOR_NAME: `t`,
  GIT_AUTHOR_EMAIL: `t@example.com`,
  GIT_COMMITTER_NAME: `t`,
  GIT_COMMITTER_EMAIL: `t@example.com`,
}

/** A source tree, a repository path and a password path in one temp folder, removed afterwards. */
async function withTree(body: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: `work-backup-` })
  try {
    await body(root)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

async function write(path: string, text = `x\n`): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true })
  await Deno.writeTextFile(path, text)
}

async function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  const out = await new Deno.Command(cmd, {
    args,
    env: { ...GIT_ENV, ...env },
    stdout: `piped`,
    stderr: `piped`,
  }).output()
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
  return { code: out.code, stdout: decode(out.stdout), stderr: decode(out.stderr) }
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const result = await run(`git`, [`-C`, dir, ...args])
  assertEquals(result.code, 0, `git ${args.join(` `)}: ${result.stderr}`)
  return result.stdout.trim()
}

/** The script's environment, with an env file that holds BACKUPS_PASSWORD. */
async function envOf(root: string): Promise<Record<string, string>> {
  const envFile = join(root, `homelab`, `.env.root`)
  await write(envFile, `OTHER=x\nBACKUPS_PASSWORD=${PASSWORD}\n`)
  return {
    WORK_BACKUP_SOURCE: join(root, `code`),
    WORK_BACKUP_ENV: envFile,
    RESTIC_REPOSITORY: join(root, `repo`),
  }
}

/** A repository at `dir` with one commit pushed to a bare remote next to it. */
async function pushedRepo(root: string, dir: string): Promise<void> {
  const remote = join(root, `remotes`, `${dir.replaceAll(`/`, `_`)}.git`)
  await Deno.mkdir(remote, { recursive: true })
  await git(remote, `init`, `--quiet`, `--bare`, `--initial-branch=main`)
  await Deno.mkdir(dir, { recursive: true })
  await git(dir, `init`, `--quiet`, `--initial-branch=main`)
  await write(join(dir, `.gitignore`), `ignored.txt\n`)
  await write(join(dir, `tracked.txt`))
  await write(join(dir, `deleted.txt`))
  await git(dir, `add`, `.`)
  await git(dir, `commit`, `--quiet`, `-m`, `first`)
  await git(dir, `remote`, `add`, `origin`, remote)
  await git(dir, `push`, `--quiet`, `origin`, `main`)
}

async function backedUp(env: Record<string, string>): Promise<string[]> {
  const listed = await run(`restic`, [`ls`, `latest`], { ...env, RESTIC_PASSWORD: PASSWORD })
  assertEquals(listed.code, 0, listed.stderr)
  return listed.stdout.split(`\n`)
}

Deno.test(`restic and git are installed, so the backup tests below cannot pass by skipping`, async () => {
  assertEquals((await run(`restic`, [`version`])).code, 0)
  assertEquals((await run(`git`, [`version`])).code, 0)
})

Deno.test(`backs up folders and repositories with no remote whole, and only the uncommitted files of the others and their worktrees`, async () => {
  await withTree(async (root) => {
    const code = join(root, `code`)
    const app = join(code, `app`)
    await pushedRepo(root, app)
    await write(join(app, `tracked.txt`), `changed\n`)
    await write(join(app, `staged.txt`))
    await git(app, `add`, `staged.txt`)
    await write(join(app, `untracked/new.txt`))
    await write(join(app, `ignored.txt`))
    await Deno.remove(join(app, `deleted.txt`))
    await write(join(app, `.env`))
    await write(join(app, `.env.example`))
    await git(app, `worktree`, `add`, `--quiet`, join(code, `worktrees/app/feat/x`))
    await write(join(code, `worktrees/app/feat/x/draft.txt`))
    await git(app, `worktree`, `add`, `--quiet`, join(root, `elsewhere`))
    await write(join(root, `elsewhere/draft.txt`))

    const solo = join(code, `solo`)
    await Deno.mkdir(solo)
    await git(solo, `init`, `--quiet`)
    await write(join(solo, `notes.md`))
    await write(join(solo, `.age/key.txt`))
    await Deno.symlink(`app`, join(code, `link`))

    const kept = [
      `mcps/caldav/server.js`,
      `app/tracked.txt`,
      `app/staged.txt`,
      `app/untracked/new.txt`,
      `app/.env.example`,
      `worktrees/app/feat/x/draft.txt`,
      `solo/notes.md`,
      `solo/.git/HEAD`,
    ]
    const skipped = [
      `mcps/caldav/.env`,
      `mcps/caldav/node_modules/pkg/index.js`,
      `app/.gitignore`,
      `app/ignored.txt`,
      `app/.env`,
      `app/.git/HEAD`,
      `link/tracked.txt`,
      `solo/.age/key.txt`,
      `.stversions/app/tracked.txt`,
    ]
    for (
      const rel of [
        `mcps/caldav/server.js`,
        ...skipped.filter((r) => r.startsWith(`.`) || r.startsWith(`mcps`)),
      ]
    ) {
      await write(join(code, rel))
    }

    const env = await envOf(root)
    const backup = await run(`bash`, [SCRIPT], env)
    assertEquals(backup.code, 0, `the backup failed: ${backup.stderr}`)
    assert(!`${backup.stdout}${backup.stderr}`.includes(PASSWORD), `the password was printed`)

    const listed = await backedUp(env)
    for (const rel of kept) assert(listed.includes(join(code, rel)), `${rel} is not in the backup`)
    for (const rel of skipped) assert(!listed.includes(join(code, rel)), `${rel} is in the backup`)
    assert(
      !listed.includes(join(root, `elsewhere/draft.txt`)),
      `a worktree outside worktrees/ is in the backup`,
    )
  })
})

Deno.test(`bundles the commits on no remote, and makes no bundle for a repository that is all pushed`, async () => {
  await withTree(async (root) => {
    const code = join(root, `code`)
    const app = join(code, `app`)
    await pushedRepo(root, app)
    await pushedRepo(root, join(code, `clean`))
    await git(app, `switch`, `--quiet`, `-c`, `local`)
    await write(join(app, `local.txt`))
    await git(app, `add`, `local.txt`)
    await git(app, `commit`, `--quiet`, `-m`, `local only`)
    const local = await git(app, `rev-parse`, `HEAD`)

    const env = await envOf(root)
    assertEquals((await run(`bash`, [SCRIPT], env)).code, 0, `the backup failed`)
    const bundles = (await backedUp(env)).filter((path) => path.endsWith(`.bundle`))
    assertEquals(bundles.map((path) => path.split(`/`).pop()), [`app.bundle`])

    const target = join(root, `restore`)
    const restored = await run(`restic`, [
      `restore`,
      `latest`,
      `--target`,
      target,
      `--include`,
      bundles[0],
    ], {
      ...env,
      RESTIC_PASSWORD: PASSWORD,
    })
    assertEquals(restored.code, 0, restored.stderr)
    const file = join(target, bundles[0])
    await git(app, `bundle`, `verify`, `--quiet`, file)
    assert((await git(app, `bundle`, `list-heads`, file)).includes(`${local} refs/heads/local`))
  })
})

Deno.test(`saves each stash as a patch that restores it, untracked files included`, async () => {
  await withTree(async (root) => {
    const code = join(root, `code`)
    const app = join(code, `app`)
    await pushedRepo(root, app)
    await write(join(app, `tracked.txt`), `stashed change\n`)
    await write(join(app, `new.txt`), `stashed new file\n`)
    await git(app, `stash`, `push`, `--quiet`, `--include-untracked`)

    const env = await envOf(root)
    assertEquals((await run(`bash`, [SCRIPT], env)).code, 0, `the backup failed`)
    const patches = (await backedUp(env)).filter((path) => path.endsWith(`.patch`))
    assertEquals(patches.map((path) => path.split(`/`).pop()), [`app.stash-0.patch`])

    const target = join(root, `restore`)
    const restored = await run(`restic`, [`restore`, `latest`, `--target`, target], {
      ...env,
      RESTIC_PASSWORD: PASSWORD,
    })
    assertEquals(restored.code, 0, restored.stderr)
    await git(app, `apply`, join(target, patches[0]))
    assertEquals(await Deno.readTextFile(join(app, `tracked.txt`)), `stashed change\n`)
    assertEquals(await Deno.readTextFile(join(app, `new.txt`)), `stashed new file\n`)
  })
})

Deno.test(`bundles commits only a detached HEAD holds, and none for a detached HEAD on pushed work`, async () => {
  await withTree(async (root) => {
    const code = join(root, `code`)
    const app = join(code, `app`)
    const clean = join(code, `clean`)
    await pushedRepo(root, app)
    await pushedRepo(root, clean)
    await git(clean, `switch`, `--quiet`, `--detach`)
    await git(app, `switch`, `--quiet`, `--detach`)
    await write(join(app, `local.txt`))
    await git(app, `add`, `local.txt`)
    await git(app, `commit`, `--quiet`, `-m`, `detached only`)
    const head = await git(app, `rev-parse`, `HEAD`)

    const env = await envOf(root)
    assertEquals((await run(`bash`, [SCRIPT], env)).code, 0, `the backup failed`)
    const bundles = (await backedUp(env)).filter((path) => path.endsWith(`.bundle`))
    assertEquals(bundles.map((path) => path.split(`/`).pop()), [
      `app.detached-${head.slice(0, 12)}.bundle`,
    ])

    const target = join(root, `restore`)
    const restored = await run(`restic`, [`restore`, `latest`, `--target`, target], {
      ...env,
      RESTIC_PASSWORD: PASSWORD,
    })
    assertEquals(restored.code, 0, restored.stderr)
    assert((await git(app, `bundle`, `list-heads`, join(target, bundles[0]))).includes(head))
  })
})

// restic 0.17 and later also keep the oldest snapshot while fewer days than the policy exist, so
// three runs on one day leave two snapshots when retention sees them as one series, and three when
// each run's new bundle folder name makes a series of its own.
Deno.test(`repeated runs leave the repositories as they were and retention forgets runs of the same day`, async () => {
  await withTree(async (root) => {
    const app = join(root, `code`, `app`)
    await pushedRepo(root, app)
    await git(app, `switch`, `--quiet`, `-c`, `local`)
    await git(app, `commit`, `--quiet`, `--allow-empty`, `-m`, `local only`)
    await write(join(app, `tracked.txt`), `changed\n`)
    const state =
      async () => [await git(app, `status`, `--porcelain`), await git(app, `for-each-ref`)]
    const before = await state()

    const env = await envOf(root)
    for (const _ of [1, 2, 3]) {
      assertEquals((await run(`bash`, [SCRIPT], env)).code, 0, `a backup failed`)
    }

    assertEquals(await state(), before)
    const snapshots = await run(`restic`, [`snapshots`, `--json`, `--tag`, `work`], {
      ...env,
      RESTIC_PASSWORD: PASSWORD,
    })
    assert(JSON.parse(snapshots.stdout).length < 3, `retention forgot no run of the same day`)
  })
})

Deno.test(`succeeds and makes no repository when everything is committed and pushed`, async () => {
  await withTree(async (root) => {
    await pushedRepo(root, join(root, `code`, `app`))
    const env = await envOf(root)
    const result = await run(`bash`, [SCRIPT], env)
    assertEquals(result.code, 0, result.stderr)
    assertEquals(await Deno.stat(env.RESTIC_REPOSITORY).catch(() => null), null)
  })
})

Deno.test(`refuses to run, and makes no repository, without BACKUPS_PASSWORD`, async () => {
  await withTree(async (root) => {
    await write(join(root, `code`, `mcps`, `x.js`))
    const env = await envOf(root)
    await Deno.writeTextFile(env.WORK_BACKUP_ENV, `OTHER=x\nBACKUPS_PASSWORD=\n`)
    const result = await run(`bash`, [SCRIPT], env)
    assertEquals(result.code, 1)
    assert(result.stderr.includes(`no BACKUPS_PASSWORD`), result.stderr)
    assertEquals(await Deno.stat(env.RESTIC_REPOSITORY).catch(() => null), null)
  })
})

Deno.test(`refuses an unknown argument instead of backing up`, async () => {
  await withTree(async (root) => {
    await write(join(root, `code`, `mcps`, `x.js`))
    const env = await envOf(root)
    assertEquals((await run(`bash`, [SCRIPT, `--alret`], env)).code, 2)
    assertEquals(await Deno.stat(env.RESTIC_REPOSITORY).catch(() => null), null)
  })
})
