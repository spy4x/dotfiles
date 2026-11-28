import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19"
import { exists } from "jsr:@std/fs@^1.0.0/exists"
import { fromFileUrl, join } from "jsr:@std/path@^1.0.0"

const SCRIPT = fromFileUrl(new URL(`./install-media-tools.sh`, import.meta.url))
const COMMIT = `00c1630c14fc8fc187aa4c5ae3975d81ac2e6517`
const MODEL_SUM = `c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d`
const DF_X86 = `deep-filter-0.5.6-x86_64-unknown-linux-musl`
const DF_X86_SUM = `70775e251eee44c0f2451a1e833326cf8bcbbe304d3e7cd12851e6fce72ef7da`
const DF_ARM = `deep-filter-0.5.6-aarch64-unknown-linux-gnu`
const DF_ARM_SUM = `14e02a1c0028f3ca0bdf83b62b3336e56ba0556894ef295a95e8573f06557166`
const MODEL = `.local/share/whisper.cpp/models/ggml-small.en.bin`
const CLI = `.local/bin/whisper-cli`
const DF = `.local/bin/deep-filter`

/**
 * Fake binaries first on PATH; each logs its arguments to `$FAKE_LOG/<name>`. `curl` writes
 * `good:<pinned sha256>` for a known URL (`corrupt` when FAKE_CURL_BAD is set), and `sha256sum`
 * reports the hash after `good:`, so a real checksum never has to match fake content. `git`
 * answers FAKE_COMMIT or the pinned commit; `cmake --build` writes a stub `whisper-cli`.
 */
const FAKES: Record<string, string> = {
  curl: `while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; *) url=$1 ;; esac; shift; done
case "$url" in
  *ggml-small.en.bin) sum=${MODEL_SUM} ;;
  *${DF_X86}) sum=${DF_X86_SUM} ;;
  *${DF_ARM}) sum=${DF_ARM_SUM} ;;
  *) exit 22 ;;
esac
if [ -n "$FAKE_CURL_BAD" ]; then printf corrupt >"$out"; else printf "good:$sum" >"$out"; fi`,
  sha256sum:
    `c=$(cat "$1"); case "$c" in good:*) echo "\${c#good:}  $1" ;; *) echo "0000  $1" ;; esac`,
  git: `case "$1" in
  clone) for d; do :; done; mkdir -p "$d" ;;
  -C) echo "\${FAKE_COMMIT:-${COMMIT}}" ;;
esac`,
  cmake:
    `if [ "$1" = --build ]; then mkdir -p "$2/bin"; printf '#!/bin/sh\\n' >"$2/bin/whisper-cli"; fi`,
  uname: `echo "\${FAKE_ARCH:-x86_64}"`,
}
/** Holds the fakes and every test's HOME; removed when the file finishes. */
const ROOT = await Deno.realPath(await Deno.makeTempDir({ prefix: `media-tools-test-` }))
const BIN = join(ROOT, `bin`)
await Deno.mkdir(BIN)
for (const [name, body] of Object.entries(FAKES)) {
  await Deno.writeTextFile(
    join(BIN, name),
    `#!/bin/sh\necho "$*" >>"$FAKE_LOG/${name}"\n${body}\n`,
    {
      mode: 0o755,
    },
  )
}
globalThis.addEventListener(`unload`, () => Deno.removeSync(ROOT, { recursive: true }))

interface Run {
  code: number
  out: string
  err: string
  /** Arguments each fake was called with, one line per call; empty when never called. */
  calls: (name: string) => string
}

/** Makes a fresh HOME with its own TMPDIR. */
async function newHome(): Promise<string> {
  const home = await Deno.makeTempDir({ dir: ROOT, prefix: `home-` })
  await Deno.mkdir(join(home, `tmp`))
  return home
}

/** Runs the script in `home` with a cleared environment; each run gets a fresh call log. */
async function install(home: string, env: Record<string, string> = {}): Promise<Run> {
  const log = await Deno.makeTempDir({ dir: ROOT, prefix: `log-` })
  const res = await new Deno.Command(`bash`, {
    args: [SCRIPT],
    clearEnv: true,
    env: {
      PATH: `${BIN}:/usr/bin:/bin`,
      HOME: home,
      TMPDIR: join(home, `tmp`),
      FAKE_LOG: log,
      ...env,
    },
    stdout: `piped`,
    stderr: `piped`,
  }).output()
  const dec = new TextDecoder()
  return {
    code: res.code,
    out: dec.decode(res.stdout),
    err: dec.decode(res.stderr),
    calls: (name) => {
      try {
        return Deno.readTextFileSync(join(log, name))
      } catch {
        return ``
      }
    },
  }
}

/** Names left in a directory, for "nothing left behind" checks. */
async function list(dir: string): Promise<string[]> {
  return (await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name).sort()
}

Deno.test(`installs whisper-cli, the model and deep-filter when nothing is present`, async () => {
  const home = await newHome()
  const r = await install(home)
  assertEquals(r.code, 0, r.err)
  assert((await Deno.stat(join(home, CLI))).mode! & 0o111, `whisper-cli is executable`)
  assertEquals(
    (await Deno.readTextFile(join(home, `.local/share/whisper.cpp/whisper-cli.version`))).trim(),
    COMMIT,
  )
  assertEquals(await Deno.readTextFile(join(home, MODEL)), `good:${MODEL_SUM}`)
  assertEquals(await Deno.readTextFile(join(home, DF)), `good:${DF_X86_SUM}`)
  assert((await Deno.stat(join(home, DF))).mode! & 0o111, `deep-filter is executable`)
  assertStringIncludes(r.calls(`git`), `clone --quiet --depth 1 --branch v1.9.6`)
  assertStringIncludes(r.calls(`cmake`), `-DBUILD_SHARED_LIBS=OFF`)
  assertStringIncludes(r.calls(`cmake`), `--target whisper-cli`)
  assertEquals(await list(join(home, `tmp`)), [], `the clone directory is removed`)
  assertEquals(await list(join(home, `.local/share/whisper.cpp/models`)), [`ggml-small.en.bin`])
})

Deno.test(`a second run downloads and builds nothing`, async () => {
  const home = await newHome()
  assertEquals((await install(home)).code, 0)
  const r = await install(home)
  assertEquals(r.code, 0, r.err)
  for (const fake of [`curl`, `git`, `cmake`]) assertEquals(r.calls(fake), ``, `${fake} was called`)
  assertEquals(r.out.match(/already in place/g)?.length, 3, r.out)
})

Deno.test(`replaces a model whose checksum does not match`, async () => {
  const home = await newHome()
  assertEquals((await install(home)).code, 0)
  await Deno.writeTextFile(join(home, MODEL), `stale`)
  const r = await install(home)
  assertEquals(r.code, 0, r.err)
  assertEquals(r.calls(`curl`).trim().split(`\n`).length, 1, r.calls(`curl`))
  assertStringIncludes(r.calls(`curl`), `ggml-small.en.bin`)
  assertEquals(await Deno.readTextFile(join(home, MODEL)), `good:${MODEL_SUM}`)
})

Deno.test(`a download with the wrong checksum fails and leaves no file at the final path`, async () => {
  const home = await newHome()
  const r = await install(home, { FAKE_CURL_BAD: `1` })
  assertEquals(r.code, 1)
  assertStringIncludes(r.err, `checksum mismatch`)
  assertEquals(await exists(join(home, MODEL)), false)
  assertEquals(await list(join(home, `.local/share/whisper.cpp/models`)), [], `no partial file`)
  assertEquals(await exists(join(home, DF)), false)
})

for (
  const [arch, asset, sum] of [[`x86_64`, DF_X86, DF_X86_SUM], [`aarch64`, DF_ARM, DF_ARM_SUM]]
) {
  Deno.test(`downloads the ${arch} deep-filter build on ${arch}`, async () => {
    const home = await newHome()
    const r = await install(home, { FAKE_ARCH: arch })
    assertEquals(r.code, 0, r.err)
    assertStringIncludes(r.calls(`curl`), `/v0.5.6/${asset}`)
    assertEquals(await Deno.readTextFile(join(home, DF)), `good:${sum}`)
  })
}

Deno.test(`fails on an architecture without a deep-filter build`, async () => {
  const home = await newHome()
  const r = await install(home, { FAKE_ARCH: `riscv64` })
  assertEquals(r.code, 1)
  assertStringIncludes(r.err, `no deep-filter 0.5.6 build for architecture riscv64`)
  assertEquals(await exists(join(home, DF)), false)
})

Deno.test(`fails when the cloned commit differs from the pinned one`, async () => {
  const home = await newHome()
  const r = await install(home, { FAKE_COMMIT: `deadbeef` })
  assertEquals(r.code, 1)
  assertStringIncludes(r.err, `resolved to deadbeef, expected ${COMMIT}`)
  assertEquals(r.calls(`cmake`), ``, `nothing was built`)
  assertEquals(await exists(join(home, CLI)), false)
  assertEquals(await list(join(home, `tmp`)), [], `the clone directory is removed`)
})
