import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19"
import { fromFileUrl, join } from "jsr:@std/path@^1.0.0"

const DESKTOP = fromFileUrl(new URL(`./claude-desktop-as.sh`, import.meta.url))
const CLI = fromFileUrl(new URL(`./claude-as.sh`, import.meta.url))

/** A temp home with a fake binary that prints its arguments and its token, removed afterwards. */
async function withHome(body: (home: string, fake: string) => Promise<void>): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: `claude-accounts-` })
  try {
    const fake = join(home, `fake-bin`)
    await Deno.writeTextFile(
      fake,
      `#!/usr/bin/env bash\nprintf '%s\\n' "args: $*" "token: \${CLAUDE_CODE_OAUTH_TOKEN:-none}"\n`,
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

Deno.test(`runs the CLI with the profile's stored token`, async () => {
  await withHome(async (home, fake) => {
    await Deno.mkdir(join(home, `.config/claude-work`), { recursive: true })
    await Deno.writeTextFile(join(home, `.config/claude-work/token`), `test-token`)
    const out = await run(CLI, [`work`, `auth`, `status`], { HOME: home, CLAUDE_BIN: fake })
    assertEquals(out.code, 0, out.stderr)
    assertEquals(out.stdout, `args: auth status\ntoken: test-token\n`)
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
