import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19"
import { fromFileUrl, join } from "jsr:@std/path@^1.0.0"

const SCRIPT = fromFileUrl(new URL(`./vpn-guard.sh`, import.meta.url))

// Fakes for nmcli and curl. They only use shell builtins, never the real tools, and refuse to run
// nested. nmcli keeps the connection state in a file; curl succeeds only when the VPN is up and
// FAKE_INTERNET allows the URL ("all", "cloudflare" or "none").
const FAKE_NMCLI = `#!/bin/sh
[ -n "$FAKE_DEPTH" ] && exit 99
export FAKE_DEPTH=1
echo "nmcli $*" >> "$FAKE_DIR/log"
state=$(cat "$FAKE_DIR/state")
case "$*" in
  *GENERAL.STATE*) [ "$state" = active ] && echo activated; exit 0 ;;
  *connection.interface-name*) echo wg9; exit 0 ;;
  *" up "*) [ "$FAKE_UP" = fail ] && exit 4; echo active > "$FAKE_DIR/state"; exit 0 ;;
  *" down "*) [ "$FAKE_DOWN" = fail ] && exit 4; echo inactive > "$FAKE_DIR/state"; exit 0 ;;
esac
exit 10
`
const FAKE_CURL = `#!/bin/sh
[ -n "$FAKE_DEPTH" ] && exit 99
export FAKE_DEPTH=1
echo "curl $*" >> "$FAKE_DIR/log"
[ "$(cat "$FAKE_DIR/state")" = active ] || exit 7
case "$FAKE_INTERNET:$*" in
  all:*) exit 0 ;;
  cloudflare:*cloudflare.com*) exit 0 ;;
esac
exit 28
`

interface Run {
  code: number
  stdout: string
  log: string[]
  active: boolean
}

/** Runs vpn-guard against the fakes, starting with the VPN `start`, and cleans up after. */
async function guard(
  start: `active` | `inactive`,
  env: Record<string, string>,
): Promise<Run> {
  const dir = await Deno.makeTempDir({ prefix: `vpn-guard-` })
  try {
    const bin = join(dir, `bin`)
    await Deno.mkdir(bin)
    await Deno.writeTextFile(join(bin, `nmcli`), FAKE_NMCLI, { mode: 0o755 })
    await Deno.writeTextFile(join(bin, `curl`), FAKE_CURL, { mode: 0o755 })
    await Deno.writeTextFile(join(dir, `state`), `${start}\n`)
    await Deno.writeTextFile(join(dir, `log`), ``)
    const { code, stdout } = await new Deno.Command(`bash`, {
      args: [SCRIPT],
      clearEnv: true,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        FAKE_DIR: dir,
        VPN_GUARD_CONFIG: join(dir, `missing.conf`),
        VPN_GUARD_CONNECTION: `test-vpn`,
        VPN_GUARD_RETRY_DELAY: `0`,
        FAKE_INTERNET: `all`,
        ...env,
      },
      stdout: `piped`,
      stderr: `null`,
    }).output()
    const log = (await Deno.readTextFile(join(dir, `log`))).split(`\n`).filter(Boolean)
    const active = (await Deno.readTextFile(join(dir, `state`))).trim() === `active`
    return { code, stdout: new TextDecoder().decode(stdout), log, active }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

const ups = (run: Run) => run.log.filter((line) => / up /.test(line)).length
const downs = (run: Run) => run.log.filter((line) => / down /.test(line)).length

Deno.test(`connects and stays connected when the internet works through the VPN`, async () => {
  const run = await guard(`inactive`, {})
  assertEquals(run.code, 0)
  assertEquals([ups(run), downs(run)], [1, 0])
  assert(run.active)
})

Deno.test(`disconnects again when the internet fails after connecting`, async () => {
  const run = await guard(`inactive`, { FAKE_INTERNET: `none` })
  assertEquals(run.code, 0)
  assertEquals([ups(run), downs(run)], [1, 1])
  assert(!run.active)
})

Deno.test(`leaves a working VPN alone`, async () => {
  const run = await guard(`active`, {})
  assertEquals(run.code, 0)
  assertEquals([ups(run), downs(run)], [0, 0])
  assert(run.active)
})

Deno.test(`disconnects a connected VPN that no longer carries internet`, async () => {
  const run = await guard(`active`, { FAKE_INTERNET: `none` })
  assertEquals(run.code, 0)
  assertEquals([ups(run), downs(run)], [0, 1])
  assert(!run.active)
})

Deno.test(`tries every site and retries before giving up`, async () => {
  const run = await guard(`active`, { FAKE_INTERNET: `none`, VPN_GUARD_TRIES: `3` })
  assertEquals(run.log.filter((line) => line.startsWith(`curl `)).length, 6)
})

Deno.test(`stays connected when only the second site answers`, async () => {
  const run = await guard(`active`, { FAKE_INTERNET: `cloudflare` })
  assertEquals(downs(run), 0)
  assert(run.active)
})

Deno.test(`checks the internet through the VPN interface only`, async () => {
  const run = await guard(`active`, {})
  const curls = run.log.filter((line) => line.startsWith(`curl `))
  assert(curls.length > 0)
  for (const line of curls) assertStringIncludes(line, `--interface wg9`)
})

Deno.test(`cleans up when connecting fails`, async () => {
  const run = await guard(`inactive`, { FAKE_UP: `fail` })
  assertEquals(run.code, 0)
  assertEquals(downs(run), 1)
  assert(!run.active)
})

Deno.test(`refuses to run without a connection name`, async () => {
  const run = await guard(`inactive`, { VPN_GUARD_CONNECTION: `` })
  assertEquals(run.code, 2)
  assertEquals(run.log, [])
})

const MOVE_KEYS = fromFileUrl(new URL(`./move-keys.sh`, import.meta.url))
const PEER_A = `${`A`.repeat(42)}1=`
const PEER_B = `${`B`.repeat(42)}2=`

/** Runs move-keys.sh on `profile` with a fake `wg` that reports PEER_A with a key, PEER_B without. */
async function moveKeys(
  profile: string,
): Promise<{ code: number; profile: string; mode: number; awkArgs: string }> {
  // A wrapper records awk's arguments, then runs the real awk, resolved before PATH changes.
  const realAwk = new TextDecoder().decode(
    (await new Deno.Command(`sh`, { args: [`-c`, `command -v awk`], stdout: `piped` }).output())
      .stdout,
  ).trim()
  assert(realAwk, `awk not found`)
  const dir = await Deno.makeTempDir({ prefix: `vpn-guard-keys-` })
  try {
    const bin = join(dir, `bin`)
    await Deno.mkdir(bin)
    await Deno.writeTextFile(
      join(bin, `wg`),
      `#!/bin/sh\ncase "$3" in\n  private-key) echo PRIVATE ;;\n` +
        `  preshared-keys) printf '%s\\tPSK-A\\n%s\\t(none)\\n' ${PEER_A} ${PEER_B} ;;\nesac\n`,
      { mode: 0o755 },
    )
    await Deno.writeTextFile(join(bin, `nmcli`), `#!/bin/sh\nexit 0\n`, { mode: 0o755 })
    await Deno.writeTextFile(join(bin, `restorecon`), `#!/bin/sh\nexit 0\n`, { mode: 0o755 })
    await Deno.writeTextFile(
      join(bin, `awk`),
      `#!/bin/sh\n[ -n "$FAKE_DEPTH" ] && exit 99\nexport FAKE_DEPTH=1\n` +
        `printf '%s\\n' "$@" >> "$FAKE_DIR/awk-args"\nexec "$REAL_AWK" "$@"\n`,
      { mode: 0o755 },
    )
    const file = join(dir, `test.nmconnection`)
    await Deno.writeTextFile(file, profile)
    const { code } = await new Deno.Command(`bash`, {
      args: [MOVE_KEYS, `wg9`, file],
      clearEnv: true,
      env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_DIR: dir, REAL_AWK: realAwk },
      stdout: `null`,
      stderr: `null`,
    }).output()
    const leftovers = [...Deno.readDirSync(dir)].filter((e) => e.name.startsWith(`.vpn-guard`))
    assertEquals(leftovers, [])
    return {
      code,
      profile: await Deno.readTextFile(file),
      mode: (await Deno.stat(file)).mode! & 0o777,
      awkArgs: await Deno.readTextFile(join(dir, `awk-args`)),
    }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

const KEYRING_PROFILE = `[connection]
id=x

[wireguard]
listen-port=51820
private-key-flags=1

[wireguard-peer.${PEER_A}]
endpoint=vpn.example.com:51820
preshared-key-flags=1
allowed-ips=0.0.0.0/0;

[wireguard-peer.${PEER_B}]
preshared-key-flags=1

[ipv4]
method=manual
`

Deno.test(`move-keys writes the keys from the interface into the profile`, async () => {
  const run = await moveKeys(KEYRING_PROFILE)
  assertEquals(run.code, 0)
  assertEquals(
    run.profile,
    `[connection]
id=x

[wireguard]
private-key=PRIVATE
listen-port=51820

[wireguard-peer.${PEER_A}]
endpoint=vpn.example.com:51820
allowed-ips=0.0.0.0/0;
preshared-key=PSK-A

[wireguard-peer.${PEER_B}]
preshared-key-flags=4

[ipv4]
method=manual
`,
  )
})

Deno.test(`move-keys leaves the profile readable by root only`, async () => {
  const run = await moveKeys(KEYRING_PROFILE)
  assertEquals(run.mode, 0o600)
})

Deno.test(`move-keys never puts a key in a command line`, async () => {
  const run = await moveKeys(KEYRING_PROFILE)
  assertEquals(run.code, 0)
  assert(run.awkArgs.length > 0, `awk was not called through the wrapper`)
  assert(!run.awkArgs.includes(`PRIVATE`), `private key in awk's arguments`)
  assert(!run.awkArgs.includes(`PSK-A`), `preshared key in awk's arguments`)
})

Deno.test(`fails loudly when a dead VPN cannot be disconnected`, async () => {
  const run = await guard(`active`, { FAKE_INTERNET: `none`, FAKE_DOWN: `fail` })
  assertEquals(run.code, 1)
  assert(run.active)
  assertStringIncludes(run.stdout, `disconnect failed`)
})
