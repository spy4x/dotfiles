import { assert, assertEquals } from "jsr:@std/assert@1.0.19"
import { dirname, fromFileUrl, join } from "jsr:@std/path@^1.0.0"

const SCRIPT = fromFileUrl(new URL(`./secrets-backup.sh`, import.meta.url))

/** A source tree, a repository path and a password path in one temp folder, removed afterwards. */
async function withTree(body: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: `secrets-backup-` })
  try {
    await body(root)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

async function write(path: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true })
  await Deno.writeTextFile(path, `x\n`)
}

const PASSWORD = `test-password`

/** The script's environment, with an env file that holds BACKUPS_PASSWORD. */
async function envOf(root: string): Promise<Record<string, string>> {
  const envFile = join(root, `homelab`, `.env.root`)
  await Deno.mkdir(dirname(envFile), { recursive: true })
  await Deno.writeTextFile(envFile, `OTHER=x\nBACKUPS_PASSWORD=${PASSWORD}\n`)
  return {
    SECRETS_BACKUP_SOURCE: join(root, `code`),
    SECRETS_BACKUP_ENV: envFile,
    RESTIC_REPOSITORY: join(root, `repo`),
  }
}

async function run(cmd: string, args: string[], env: Record<string, string>) {
  const out = await new Deno.Command(cmd, { args, env, stdout: `piped`, stderr: `piped` }).output()
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
  return { code: out.code, stdout: decode(out.stdout), stderr: decode(out.stderr) }
}

Deno.test(`restic is installed, so the backup tests below cannot pass by skipping`, async () => {
  assertEquals((await run(`restic`, [`version`], {})).code, 0)
})

Deno.test(`backs up age keys and env files, folders and symlinks, and skips ciphertext, examples and worktrees`, async () => {
  await withTree(async (root) => {
    const code = join(root, `code`)
    const kept = [
      `homelab/.age/key.txt`,
      `homelab/.env`,
      `homelab/.env.accounts`,
      `rostok/servers/cloud/configs/mig.env`,
      `rostok/servers/cloud/configs/mig.env.bak-20260826`,
      `app/.env.d/secret`,
      `app/symlink/.env`,
    ]
    const skipped = [
      `homelab/.env.age`,
      `homelab/.env.accounts.age`,
      `homelab/.env.example`,
      `homelab/README.md`,
      `worktrees/homelab/fix/x/.env`,
      `worktrees/homelab/fix/x/.age/key.txt`,
      `app/node_modules/pkg/.env`,
      `app/.git/.env`,
    ]
    for (const rel of [...kept, ...skipped]) {
      if (rel !== `app/symlink/.env`) await write(join(code, rel))
    }
    await Deno.mkdir(join(code, `app`, `symlink`))
    await Deno.symlink(`real-target`, join(code, `app`, `symlink`, `.env`))

    const env = await envOf(root)
    const backup = await run(`bash`, [SCRIPT], env)
    assertEquals(backup.code, 0, `the backup failed`)

    const opened = { ...env, RESTIC_PASSWORD: PASSWORD }
    const listed = (await run(`restic`, [`ls`, `latest`], opened)).stdout.split(`\n`)
    for (const rel of kept) assert(listed.includes(join(code, rel)), `${rel} is not in the backup`)
    for (const rel of skipped) {
      assert(!listed.includes(join(code, rel)), `${rel} is in the backup`)
    }
  })
})

Deno.test(`refuses to run, and makes no repository, without BACKUPS_PASSWORD`, async () => {
  await withTree(async (root) => {
    await write(join(root, `code`, `homelab`, `.env`))
    const env = await envOf(root)
    await Deno.writeTextFile(env.SECRETS_BACKUP_ENV, `OTHER=x\nBACKUPS_PASSWORD=\n`)
    const result = await run(`bash`, [SCRIPT], env)
    assertEquals(result.code, 1)
    assert(result.stderr.includes(`no BACKUPS_PASSWORD`), result.stderr)
    assertEquals(await Deno.stat(env.RESTIC_REPOSITORY).catch(() => null), null)
  })
})

Deno.test(`refuses an unknown argument instead of backing up`, async () => {
  await withTree(async (root) => {
    await write(join(root, `code`, `homelab`, `.env`))
    const env = await envOf(root)
    assertEquals((await run(`bash`, [SCRIPT, `--alret`], env)).code, 2)
    assertEquals(await Deno.stat(env.RESTIC_REPOSITORY).catch(() => null), null)
  })
})
