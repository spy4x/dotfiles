import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1.0.19"
import { fromFileUrl, join } from "jsr:@std/path@^1.0.0"
import {
  EVERY_ACCOUNT,
  parseClients,
  REPOSITORIES,
  sessionProfile,
  workPaths,
  workVerdict,
} from "../ai-harnesses/settings/claude/mods/harness-rules/hooks/accounts.ts"

const DESKTOP = fromFileUrl(new URL(`./claude-desktop-as.sh`, import.meta.url))
const CLI = fromFileUrl(new URL(`./claude-as.sh`, import.meta.url))

/** A temp home with a fake binary that prints its arguments and its token, removed afterwards. */
async function withHome(body: (home: string, fake: string) => Promise<void>): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: `claude-accounts-` })
  try {
    const fake = join(home, `fake-bin`)
    await Deno.writeTextFile(
      fake,
      `#!/usr/bin/env bash\nprintf '%s\\n' "args: $*" "token: \${CLAUDE_CODE_OAUTH_TOKEN:-none}" ` +
        `"profile: \${CLAUDE_ACCOUNT_PROFILE:-none}"\n`,
      { mode: 0o755 },
    )
    await body(home, fake)
  } finally {
    await Deno.remove(home, { recursive: true })
  }
}

async function run(script: string, args: string[], env: Record<string, string>) {
  const out = await new Deno.Command(script, {
    args,
    env: { PATH: Deno.env.get(`PATH`) ?? ``, ...env },
    clearEnv: true,
    stdout: `piped`,
    stderr: `piped`,
  }).output()
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
  return { code: out.code, stdout: decode(out.stdout), stderr: decode(out.stderr) }
}

Deno.test(`starts the desktop app on the profile's own data folder`, async () => {
  await withHome(async (home, fake) => {
    const out = await run(DESKTOP, [`work`, `claude://x`], { HOME: home, CLAUDE_DESKTOP_BIN: fake })
    assertEquals(out.code, 0, out.stderr)
    assertStringIncludes(out.stdout, `args: --user-data-dir=${home}/.config/Claude-work claude://x`)
  })
})

Deno.test(`refuses a profile name that could leave the config folder`, async () => {
  await withHome(async (home, fake) => {
    for (const script of [DESKTOP, CLI]) {
      const out = await run(script, [`../x`], {
        HOME: home,
        CLAUDE_DESKTOP_BIN: fake,
        CLAUDE_BIN: fake,
      })
      assert(out.code !== 0)
      assertEquals(out.stdout, ``)
    }
  })
})

Deno.test(`installs a menu entry that starts the profile, with its own icon`, async () => {
  await withHome(async (home) => {
    // Stands in for ImageMagick: copies the source icon (first argument) to the target (last).
    const magick = join(home, `fake-magick`)
    await Deno.writeTextFile(magick, `#!/usr/bin/env bash\ncp "$1" "\${@: -1}"\n`, { mode: 0o755 })
    const icon = join(home, `source.png`)
    await Deno.writeTextFile(icon, `png`)
    const env = { HOME: home, MAGICK: magick, CLAUDE_DESKTOP_ICON: icon }
    const out = await run(DESKTOP, [`--install`, `work`, `Work Co`], env)
    assertEquals(out.code, 0, out.stderr)
    const entry = await Deno.readTextFile(
      join(home, `.local/share/applications/claude-desktop-work.desktop`),
    )
    assertStringIncludes(entry, `Name=Claude Work Co\n`)
    assertStringIncludes(entry, `Exec="${home}/.local/bin/claude-desktop-as" work %U\n`)
    assertStringIncludes(entry, `Icon=claude-desktop-work\n`)
    const installed = join(home, `.local/share/icons/hicolor/256x256/apps/claude-desktop-work.png`)
    assertEquals(await Deno.readTextFile(installed), `png`)
  })
})

Deno.test(`runs the CLI with the profile's stored token and tells it the profile`, async () => {
  await withHome(async (home, fake) => {
    await Deno.mkdir(join(home, `.config/claude-work`), { recursive: true })
    await Deno.writeTextFile(join(home, `.config/claude-work/token`), `test-token`)
    const out = await run(CLI, [`work`, `auth`, `status`], { HOME: home, CLAUDE_BIN: fake })
    assertEquals(out.code, 0, out.stderr)
    assertEquals(out.stdout, `args: auth status\ntoken: test-token\nprofile: work\n`)
  })
})

Deno.test(`refuses to run the CLI on a profile that has no token yet`, async () => {
  await withHome(async (home, fake) => {
    const out = await run(CLI, [`work`], { HOME: home, CLAUDE_BIN: fake })
    assert(out.code !== 0)
    assertEquals(out.stdout, ``)
    assertStringIncludes(out.stderr, `claude-as work --setup`)
  })
})

/** A private client list that also names a repository the tracked list owns. */
const CLIENTS = { "client-repo": `acme`, financy: `acme` }

/**
 * A temp home with ~/sync/code holding a few repositories, a client's, a worktree, a plain folder
 * and an unlisted repository; runs `body` with the verdict for a session on `profile`, then
 * removes it.
 */
async function withCode(
  body: (judge: (path: string, profile: string) => Promise<string | undefined>) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: `claude-accounts-code-` })
  try {
    const code = join(home, `sync/code`)
    for (const repo of [`seed`, `financy`, `dotfiles`, `unlisted`, `client-repo`]) {
      await Deno.mkdir(join(code, repo, `.git`), { recursive: true })
    }
    await Deno.mkdir(join(code, `notes`), { recursive: true })
    await Deno.mkdir(join(code, `worktrees/financy/feat/x`), { recursive: true })
    const hasGit = (dir: string) => Deno.stat(join(dir, `.git`)).then(() => true, () => false)
    const clients = () => Promise.resolve(CLIENTS)
    await body(async (path, profile) =>
      (await workVerdict([path.replace(`~`, home)], home, profile, hasGit, clients)).deny
    )
  } finally {
    await Deno.remove(home, { recursive: true })
  }
}

Deno.test(`allows work in a repository on the account that owns it`, async () => {
  await withCode(async (judge) => {
    assertEquals(await judge(`~/sync/code/seed/src`, `personal`), undefined)
    assertEquals(await judge(`~/sync/code/financy`, `neatsoft`), undefined)
  })
})

Deno.test(`refuses work in a repository of another account, naming both accounts`, async () => {
  await withCode(async (judge) => {
    const deny = await judge(`~/sync/code/financy/src`, `personal`)
    assertStringIncludes(deny ?? ``, `financy belongs to the neatsoft account`)
    assertStringIncludes(deny ?? ``, `this session runs on personal`)
  })
})

Deno.test(`allows a repository every account uses on any account`, async () => {
  await withCode(async (judge) => {
    assertEquals(await judge(`~/sync/code/dotfiles`, `neatsoft`), undefined)
    assertEquals(await judge(`~/sync/code/dotfiles`, `client`), undefined)
  })
})

Deno.test(`refuses an unlisted repository and says where to add it`, async () => {
  await withCode(async (judge) => {
    const deny = await judge(`~/sync/code/unlisted`, `personal`)
    assertStringIncludes(deny ?? ``, `unlisted belongs to no Claude account yet`)
    assertStringIncludes(deny ?? ``, `docs/claude-accounts.md`)
    assertStringIncludes(deny ?? ``, `~/sync/code/ai-memory/claude-accounts.json`)
  })
})

Deno.test(`keeps a client repository on the profile the private list names`, async () => {
  await withCode(async (judge) => {
    assertEquals(await judge(`~/sync/code/client-repo`, `acme`), undefined)
    assertStringIncludes(
      await judge(`~/sync/code/client-repo`, `personal`) ?? ``,
      `client-repo belongs to the acme account`,
    )
  })
})

Deno.test(`lets the tracked list win over the private list for a repository in both`, async () => {
  await withCode(async (judge) => {
    assertEquals(await judge(`~/sync/code/financy`, `neatsoft`), undefined)
    assertStringIncludes(
      await judge(`~/sync/code/financy`, `acme`) ?? ``,
      `financy belongs to the neatsoft account`,
    )
  })
})

Deno.test(`reads the private client list only when it maps names to profiles`, () => {
  assertEquals(parseClients(`{"client-repo":"acme"}`), { "client-repo": `acme` })
  for (const text of [`[]`, `null`, `{"client-repo":1}`, `not json`]) {
    assertThrows(() => parseClients(text))
  }
})

Deno.test(`judges a linked worktree as its repository`, async () => {
  await withCode(async (judge) => {
    assertStringIncludes(
      await judge(`~/sync/code/worktrees/financy/feat/x`, `personal`) ?? ``,
      `belongs to the neatsoft account`,
    )
    assertEquals(await judge(`~/sync/code/worktrees/financy/feat/x`, `neatsoft`), undefined)
  })
})

Deno.test(`allows a folder that is no repository or lies outside ~/sync/code`, async () => {
  await withCode(async (judge) => {
    assertEquals(await judge(`~/sync/code/notes`, `client`), undefined)
    assertEquals(await judge(`~/sync/code`, `client`), undefined)
    assertEquals(await judge(`/tmp/financy`, `personal`), undefined)
    assertEquals(await judge(`~/sync/financy`, `personal`), undefined)
  })
})

Deno.test(`reads the session's profile from the desktop app's folder, then the variable`, () => {
  const desktop = (folder: string) => `/home/u/.config/${folder}/claude-code/2.1.330/abc/claude`
  assertEquals(sessionProfile(desktop(`Claude-neatsoft`), `work`), `neatsoft`)
  assertEquals(sessionProfile(desktop(`Claude`), undefined), `personal`)
  assertEquals(sessionProfile(`/home/u/.local/share/claude/versions/2.1.331`, `client`), `client`)
})

Deno.test(`takes the personal account when nothing names a profile`, () => {
  assertEquals(sessionProfile(undefined, undefined), `personal`)
  assertEquals(sessionProfile(`/home/u/.local/share/claude/versions/2.1.331`, ``), `personal`)
})

Deno.test(`finds the folders a tool call works in, and none for a read`, () => {
  assertEquals(
    workPaths(`Bash`, { command: `cd ~/sync/code/seed && git -C "/x/y" status; ls ~/z` }),
    [`~/sync/code/seed`, `/x/y`],
  )
  assertEquals(workPaths(`Write`, { file_path: `/a/b.ts` }), [`/a/b.ts`])
  assertEquals(workPaths(`Edit`, { file_path: `/a/b.ts` }), [`/a/b.ts`])
  assertEquals(workPaths(`Read`, { file_path: `/a/b.ts` }), [])
})

Deno.test(`reads a relative target from the call's working directory`, async () => {
  const seed = `/h/sync/code/seed`
  assertEquals(
    workPaths(`Bash`, { command: `cd ../financy && git -C sub status; cd -` }, seed),
    [`${seed}/../financy`, `${seed}/../financy/sub`],
  )
  assertEquals(workPaths(`Bash`, { command: `cd /x && cd y` }), [`/x`, `/x/y`])
  assertEquals(workPaths(`Write`, { file_path: `../financy/a.ts` }, seed), [
    `${seed}/../financy/a.ts`,
  ])
  await withCode(async (judge) => {
    const [path = ``] = workPaths(`Bash`, { command: `cd ../financy` }, `~/sync/code/seed`)
    assertStringIncludes(await judge(path, `personal`) ?? ``, `financy belongs to the neatsoft`)
  })
})

Deno.test(`keeps the doc's account table and the hook's list the same`, async () => {
  const doc = await Deno.readTextFile(new URL(`../docs/claude-accounts.md`, import.meta.url))
  const table = doc.split(`## Which account does what`)[1]?.split(`\n## `)[0] ?? ``
  // The rows below the header and its `| ---` line, but the client row: its repositories and
  // profile are in the private list, which this public repository never reads.
  const rows = table.split(`\n`).filter((line) => line.startsWith(`| `)).slice(2)
    .filter((row) => row.split(`|`)[2]?.trim() !== `private`)
  const listed = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort()
  const fromDoc = Object.fromEntries(rows.map((row) => {
    const [, , profile = ``, repos = ``] = row.split(`|`)
    const name = listed(profile)[0] ?? profile.trim()
    return [name === `any` ? `every` : name, listed(repos)]
  }))
  const fromList = Object.fromEntries([
    ...Object.entries(REPOSITORIES).map(([profile, repos]) => [profile, [...repos].sort()]),
    [`every`, [...EVERY_ACCOUNT].sort()],
  ])
  assertEquals(fromDoc, fromList)
})
