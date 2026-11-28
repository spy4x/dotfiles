import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19"
import { fromFileUrl, join } from "jsr:@std/path@^1.0.0"

const SCRIPT = fromFileUrl(new URL(`./record.sh`, import.meta.url))
const MIC = `alsa_input.usb-Test_Mic-00.mono-fallback`

/** The real ffmpeg, resolved before PATH changes, so the fake `pw-record` can write a real wav. */
const FFMPEG = new TextDecoder().decode(
  (await new Deno.Command(`sh`, { args: [`-c`, `command -v ffmpeg`], stdout: `piped` }).output())
    .stdout,
).trim()
assert(FFMPEG, `ffmpeg must be installed: the silence check runs it`)

/**
 * Fake binaries first on PATH. Each logs its arguments to `$FAKE_LOG/<name>` and answers from
 * FAKE_* variables. `obs` writes a new recording unless FAKE_OBS_NOFILE is set; `pw-record`
 * writes one second of silence or of a tone (FAKE_MIC=tone) to its last argument with the real
 * ffmpeg. A fake that finds itself nested exits 99.
 */
const FAKES: Record<string, string> = {
  obs: `[ -n "$FAKE_OBS_NOFILE" ] || printf new >"$HOME/recordings/Coding-new.mkv"`,
  pgrep: `[ -n "$FAKE_OBS_RUNNING" ]`,
  pactl: `case "$1" in
  list) [ -n "$FAKE_MIC_MISSING" ] || printf '1\\t${MIC}\\tPipeWire\\ts16le 1ch 48000Hz\\tRUNNING\\n'
    printf '2\\tother.monitor\\tPipeWire\\ts16le 2ch 48000Hz\\tIDLE\\n' ;;
  get-source-mute) if [ -n "$FAKE_MUTED" ]; then echo "Mute: yes"; else echo "Mute: no"; fi ;;
  *) exit 1 ;;
esac`,
  "pw-record": `for out; do :; done
if [ "$FAKE_MIC" = tone ]; then src="sine=frequency=440:duration=1"; else src="anullsrc=r=48000:cl=mono"; fi
"$REAL_FFMPEG" -nostdin -loglevel error -y -f lavfi -i "$src" -t 1 "$out"`,
  "v4l2-ctl": `[ -z "$FAKE_CAM_FAIL" ]`,
  tmux: `:`,
  "xdg-open": `:`,
}
/** Holds the fakes and every test's HOME; removed when the file finishes. */
const ROOT = await Deno.realPath(await Deno.makeTempDir({ prefix: `record-test-` }))
const BIN = join(ROOT, `bin`)
await Deno.mkdir(BIN)
for (const [name, body] of Object.entries(FAKES)) {
  await Deno.writeTextFile(
    join(BIN, name),
    `#!/bin/sh
[ -z "$FAKE_DEPTH" ] || exit 99
export FAKE_DEPTH=1
echo "$*" >>"$FAKE_LOG/${name}"
${body}
`,
    { mode: 0o755 },
  )
}
globalThis.addEventListener(`unload`, () => Deno.removeSync(ROOT, { recursive: true }))

interface Run {
  code: number
  out: string
  /** Arguments each fake was called with, one line per call; empty when never called. */
  calls: (name: string) => string
  home: string
}

/**
 * Runs `record` with a fresh HOME holding the OBS scene collection fixture (camera at
 * `$HOME/video0`, created unless `camera` is false) and, when `kit` is given, the slug's kit.
 * `before` prepares HOME further. The environment is cleared, so the caller's TMUX never leaks.
 */
async function record(
  args: string[],
  opts: {
    env?: Record<string, string>
    kit?: string
    camera?: boolean
    before?: (home: string) => Promise<void>
  } = {},
): Promise<Run> {
  const home = await Deno.makeTempDir({ dir: ROOT, prefix: `home-` })
  const log = join(home, `log`)
  const scenes = join(home, `.config/obs-studio/basic/scenes`)
  await Deno.mkdir(log)
  await Deno.mkdir(scenes, { recursive: true })
  await Deno.mkdir(join(home, `recordings`))
  const cam = join(home, `video0`)
  if (opts.camera !== false) await Deno.writeTextFile(cam, ``)
  await Deno.writeTextFile(
    join(scenes, `YouTube-Coding.json`),
    JSON.stringify({
      AuxAudioDevice1: { id: `pulse_input_capture`, settings: { device_id: MIC } },
      sources: [
        { id: `pulse_input_capture`, settings: { device_id: MIC } },
        { id: `v4l2_input`, name: `Webcam`, settings: { device_id: cam } },
      ],
    }),
  )
  if (opts.kit !== undefined && args[0]) {
    await Deno.mkdir(join(home, `recordings`, args[0]))
    await Deno.writeTextFile(join(home, `recordings`, args[0], `kit.md`), opts.kit)
  }
  await opts.before?.(home)
  const res = await new Deno.Command(SCRIPT, {
    args,
    clearEnv: true,
    env: {
      HOME: home,
      PATH: `${BIN}:/usr/bin:/bin`,
      FAKE_LOG: log,
      REAL_FFMPEG: FFMPEG,
      FAKE_MIC: `tone`,
      ...opts.env,
    },
    stdout: `piped`,
    stderr: `piped`,
  }).output()
  const dec = new TextDecoder()
  return {
    code: res.code,
    out: dec.decode(res.stdout) + dec.decode(res.stderr),
    calls: (name) => {
      try {
        return Deno.readTextFileSync(join(log, name))
      } catch {
        return ``
      }
    },
    home,
  }
}

const exists = (path: string) => Deno.stat(path).then(() => true, () => false)
const KIT_CAMERA = "- OBS profile `YouTube-Coding`, scene `CameraOnly` (the full camera frame).\n"

for (const slug of [`../x`, `A b`, ``]) {
  Deno.test(`rejects the slug ${JSON.stringify(slug)} with exit 2 and starts no OBS`, async () => {
    const r = await record([slug])
    assertEquals(r.code, 2, r.out)
    assertEquals(r.calls(`obs`), ``)
  })
}

Deno.test(`refuses to start while OBS is already running`, async () => {
  const r = await record([`week-1`], { env: { FAKE_OBS_RUNNING: `1` } })
  assertEquals(r.code, 1, r.out)
  assertStringIncludes(r.out, `close OBS first`)
  assertEquals(r.calls(`obs`), ``)
})

Deno.test(`refuses when the microphone is unplugged`, async () => {
  const r = await record([`week-1`], { env: { FAKE_MIC_MISSING: `1` } })
  assertEquals(r.code, 1, r.out)
  assertStringIncludes(r.out, `microphone not found`)
  assertEquals(r.calls(`obs`), ``)
})

Deno.test(`refuses when the microphone is muted`, async () => {
  const r = await record([`week-1`], { env: { FAKE_MUTED: `1` } })
  assertEquals(r.code, 1, r.out)
  assertStringIncludes(r.out, `microphone is muted`)
  assertEquals(r.calls(`obs`), ``)
})

Deno.test(`refuses when the microphone records digital silence`, async () => {
  const r = await record([`week-1`], { env: { FAKE_MIC: `silence` } })
  assertEquals(r.code, 1, r.out)
  assertStringIncludes(r.out, `microphone gives no signal`)
  assertEquals(r.calls(`obs`), ``)
})

Deno.test(`refuses when the camera device is missing`, async () => {
  const r = await record([`week-1`], { camera: false })
  assertEquals(r.code, 1, r.out)
  assertStringIncludes(r.out, `camera device missing`)
  assertEquals(r.calls(`obs`), ``)
})

Deno.test(`refuses when the camera gives no frame`, async () => {
  const r = await record([`week-1`], { env: { FAKE_CAM_FAIL: `1` } })
  assertEquals(r.code, 1, r.out)
  assertStringIncludes(r.out, `camera gives no frame`)
  assertEquals(r.calls(`obs`), ``)
})

Deno.test(`--check passes on working devices and starts no OBS`, async () => {
  const r = await record([`--check`])
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.out, `camera ok`)
  assertEquals(r.calls(`obs`), ``)
})

Deno.test(`records the scene the kit names and files it as raw.mkv`, async () => {
  const r = await record([`week-1`], { kit: KIT_CAMERA, env: { TMUX: `fake` } })
  assertEquals(r.code, 0, r.out)
  assertEquals(
    r.calls(`obs`).trim(),
    `--profile YouTube-Coding --collection YouTube-Coding --scene CameraOnly --startrecording`,
  )
  const raw = join(r.home, `recordings/week-1/raw.mkv`)
  assertEquals(await Deno.readTextFile(raw), `new`)
  assertStringIncludes(r.out, raw)
  assertStringIncludes(r.calls(`tmux`), `split-window -h less ${r.home}/recordings/week-1/kit.md`)
  assertEquals(r.calls(`xdg-open`), ``)
})

Deno.test(`records CodingScene when there is no kit`, async () => {
  const r = await record([`week-1`])
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.calls(`obs`), `--scene CodingScene --startrecording`)
  assertStringIncludes(r.out, `no kit`)
  assert(await exists(join(r.home, `recordings/week-1/raw.mkv`)))
})

Deno.test(`a second recording becomes raw-2.mkv and leaves raw.mkv untouched`, async () => {
  const r = await record([`week-1`], {
    kit: `no scene named here\n`,
    before: (home) => Deno.writeTextFile(join(home, `recordings/week-1/raw.mkv`), `first take`),
  })
  assertEquals(r.code, 0, r.out)
  assertStringIncludes(r.calls(`obs`), `--scene CodingScene`)
  assertStringIncludes(r.calls(`xdg-open`), `kit.md`)
  assertEquals(await Deno.readTextFile(join(r.home, `recordings/week-1/raw.mkv`)), `first take`)
  assertEquals(await Deno.readTextFile(join(r.home, `recordings/week-1/raw-2.mkv`)), `new`)
})

Deno.test(`exits 1 when OBS wrote no new recording`, async () => {
  const r = await record([`week-1`], { env: { FAKE_OBS_NOFILE: `1` } })
  assertEquals(r.code, 1, r.out)
  assertStringIncludes(r.out, `no new .mkv`)
})

Deno.test(`leaves a recording older than the start in ~/recordings`, async () => {
  const r = await record([`week-1`], {
    before: async (home) => {
      const old = join(home, `recordings/old.mkv`)
      await Deno.writeTextFile(old, `old`)
      await Deno.utime(old, 1_000_000, 1_000_000)
    },
  })
  assertEquals(r.code, 0, r.out)
  assertEquals(await Deno.readTextFile(join(r.home, `recordings/old.mkv`)), `old`)
  assertEquals(await Deno.readTextFile(join(r.home, `recordings/week-1/raw.mkv`)), `new`)
  assert(!(await exists(join(r.home, `recordings/week-1/raw-2.mkv`))))
})
