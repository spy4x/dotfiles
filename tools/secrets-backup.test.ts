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

function envOf(root: string): Record<string, string> {
  return {
    SECRETS_BACKUP_SOURCE: join(root, `code`),
    RESTIC_REPOSITORY: join(root, `repo`),
    RESTIC_PASSWORD_FILE: join(root, `config`, `pass`),
  }
}

async function run(cmd: string, args: string[], env: Record<string, string>) {
  const out = await new Deno.Command(cmd, { args, env, stdout: `piped`, stderr: `piped` }).output()
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) }
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

    const env = envOf(root)
    const backup = await run(`bash`, [SCRIPT], env)
    assertEquals(backup.code, 0, `the backup failed`)

    const listed = (await run(`restic`, [`ls`, `latest`], env)).stdout.split(`\n`)
    for (const rel of kept) assert(listed.includes(join(code, rel)), `${rel} is not in the backup`)
    for (const rel of skipped) {
      assert(!listed.includes(join(code, rel)), `${rel} is in the backup`)
    }
    const mode = (await Deno.stat(env.RESTIC_PASSWORD_FILE)).mode! & 0o777
    assertEquals(mode, 0o600)
  })
})

Deno.test(`refuses to run when the repository exists but its password file is gone`, async () => {
  await withTree(async (root) => {
    await write(join(root, `code`, `homelab`, `.env`))
    const env = envOf(root)
    assertEquals((await run(`bash`, [SCRIPT], env)).code, 0)

    await Deno.remove(env.RESTIC_PASSWORD_FILE)
    assertEquals((await run(`bash`, [SCRIPT], env)).code, 1)
    assertEquals(await Deno.stat(env.RESTIC_PASSWORD_FILE).catch(() => null), null)
  })
})

Deno.test(`refuses an unknown argument instead of backing up`, async () => {
  await withTree(async (root) => {
    await write(join(root, `code`, `homelab`, `.env`))
    const env = envOf(root)
    assertEquals((await run(`bash`, [SCRIPT, `--alret`], env)).code, 2)
    assertEquals(await Deno.stat(env.RESTIC_REPOSITORY).catch(() => null), null)
  })
})
