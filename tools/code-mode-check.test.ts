import { assert, assertEquals } from "jsr:@std/assert@1.0.19"
import { fromFileUrl, join } from "jsr:@std/path@^1.0.0"

const SCRIPT = fromFileUrl(new URL(`./code-mode-check.sh`, import.meta.url))
const ROOT = await Deno.makeTempDir({ prefix: `code-mode-check-` })
globalThis.addEventListener(`unload`, () => Deno.removeSync(ROOT, { recursive: true }))

interface Case {
  /** Whether the fake `claude` binary contains the refusal text. */
  refusalInBinary: boolean
  /** What the probe run prints on stderr. */
  probeStderr?: string
  /** The probe run's exit code. */
  probeExit?: number
}

/**
 * Runs the check in a fresh folder with a fake `claude` and `curl` first on PATH. The fake `claude`
 * logs each probe to `probes`; the fake `curl` logs each send to `sends`.
 */
async function check(c: Case, dir?: string) {
  dir ??= await Deno.makeTempDir({ dir: ROOT })
  const bin = join(dir, `bin`)
  await Deno.mkdir(bin, { recursive: true })
  const marker = c.refusalInBinary ? `# only works in the interactive terminal` : `# allowed`
  await Deno.writeTextFile(
    join(bin, `claude`),
    `#!/bin/sh\n${marker}\n[ "$1" = --version ] && { echo "9.9.9 (Claude Code)"; exit 0; }\n` +
      `echo probe >>"${dir}/probes"\nprintf '%s' "${c.probeStderr ?? ``}" >&2\n` +
      `exit ${c.probeExit ?? 0}\n`,
    { mode: 0o755 },
  )
  await Deno.writeTextFile(
    join(bin, `curl`),
    `#!/bin/sh\necho "$*" >>"${dir}/sends"\n`,
    { mode: 0o755 },
  )
  await Deno.writeTextFile(
    join(dir, `accounts`),
    `NTFY_URL=https://ntfy.example.com\nNTFY_TOPIC=t\nNTFY_TOKEN=secret\n`,
  )
  const out = await new Deno.Command(SCRIPT, {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      CODE_MODE_STATE: join(dir, `state`, `notified`),
      CODE_MODE_ACCOUNTS: join(dir, `accounts`),
    },
    stdout: `piped`,
    stderr: `piped`,
  }).output()
  const read = (f: string) => Deno.readTextFile(join(dir, f)).catch(() => ``)
  return {
    dir,
    code: out.code,
    probes: (await read(`probes`)).split(`\n`).filter(Boolean).length,
    sends: (await read(`sends`)).split(`\n`).filter(Boolean),
    notified: await Deno.stat(join(dir, `state`, `notified`)).then(() => true, () => false),
  }
}

Deno.test(`spends no run while the binary still refuses headless Code Mode`, async () => {
  const r = await check({ refusalInBinary: true })
  assertEquals([r.code, r.probes, r.sends.length, r.notified], [0, 0, 0, false])
})

Deno.test(`stays quiet when the probe still warns about Code Mode`, async () => {
  const r = await check({
    refusalInBinary: false,
    probeStderr: `Warning: Code Mode (experimental) isn't available: reworded.`,
  })
  assertEquals([r.code, r.probes, r.sends.length, r.notified], [0, 1, 0, false])
})

Deno.test(`notifies once when headless Code Mode works`, async () => {
  const first = await check({ refusalInBinary: false })
  assertEquals([first.code, first.probes, first.sends.length, first.notified], [0, 1, 1, true])
  assert(first.sends[0].includes(`https://ntfy.example.com/t`))
  assert(!first.sends[0].includes(`secret`), `the token must not reach curl's arguments`)
  const again = await check({ refusalInBinary: false }, first.dir)
  assertEquals([again.probes, again.sends.length], [1, 1])
})

Deno.test(`fails without notifying when the probe run fails`, async () => {
  const r = await check({ refusalInBinary: false, probeExit: 1 })
  assertEquals([r.code === 0, r.sends.length, r.notified], [false, 0, false])
})
