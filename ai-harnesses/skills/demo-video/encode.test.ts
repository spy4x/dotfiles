import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19"
import {
  atFps,
  captionProblems,
  type Cue,
  encodeCommand,
  encodeDemo,
  listSeconds,
  loudnessProblems,
  musicGain,
  parseVtt,
} from "./encode.ts"

Deno.test(`parseVtt reads cue times in both stamp forms and joins a cue's lines`, () => {
  const cues = parseVtt(
    `WEBVTT\n\nNOTE staged data only\n\n00:02.000 --> 00:05.500\nAdd a service\n\n` +
      `intro\n00:00:05.500 --> 00:01:01.250 align:center\nThe card appears,\nalready checking it\n`,
  )
  assertEquals(cues, [
    { start: 2, end: 5.5, text: `Add a service` },
    { start: 5.5, end: 61.25, text: `The card appears, already checking it` },
  ])
})

Deno.test(`parseVtt refuses a file that is not WebVTT`, () => {
  assertThrows(() => parseVtt(`00:02.000 --> 00:05.000\nHello\n`), Error, `WEBVTT`)
})

const cue = (start: number, end: number, text = `Add a service`): Cue => ({ start, end, text })

Deno.test(`captionProblems passes readable captions between the cards`, () => {
  assertEquals(captionProblems([cue(2, 4.5), cue(4.5, 8)], 2, 10), [])
})

Deno.test(`captionProblems refuses a caption shown too briefly to read`, () => {
  const long = `The card appears, already checking it, and turns green` // 54 chars: 3.6 s
  assertEquals(captionProblems([cue(2, 4.4)], 2, 10).length, 1)
  assertEquals(captionProblems([cue(2, 5, long)], 2, 10).length, 1)
  assertEquals(captionProblems([cue(2, 5.6, long)], 2, 10), [])
})

Deno.test(`captionProblems refuses a caption too long for one line`, () => {
  assertEquals(captionProblems([cue(2, 8, `x`.repeat(65))], 2, 10).length, 1)
})

Deno.test(`captionProblems refuses overlapping captions and captions over a card`, () => {
  assertEquals(captionProblems([cue(2, 5), cue(4.5, 8)], 2, 10).length, 1)
  assertEquals(captionProblems([cue(1, 4)], 2, 10).length, 1)
  assertEquals(captionProblems([cue(8, 10.5)], 2, 10).length, 1)
})

Deno.test(`captionProblems refuses a video with no captions`, () => {
  assertEquals(captionProblems([], 2, 10).length, 1)
})

Deno.test(`loudnessProblems refuses a mix louder than -27 LUFS or peaking above -1 dBTP`, () => {
  assertEquals(loudnessProblems({ integrated: -28, peak: -3 }), [])
  assertEquals(loudnessProblems({ integrated: -26.9, peak: -3 }).length, 1)
  assertEquals(loudnessProblems({ integrated: -28, peak: -0.9 }).length, 1)
})

Deno.test(`musicGain brings music to -28 LUFS unless its peak would pass -2 dBTP`, () => {
  assertEquals(musicGain({ integrated: -18, peak: -6 }), -10)
  assertEquals(musicGain({ integrated: -40, peak: -6 }), 4)
})

Deno.test(`listSeconds adds up a concat list's durations`, () => {
  const list =
    `file 'a.jpg'\noption framerate 30\nduration 1\nfile 'b.jpg'\nduration 0.25\nfile 'b.jpg'\n`
  assertEquals(listSeconds(list), 1.25)
  assertThrows(() => listSeconds(`file 'a.jpg'\n`), Error, `lists no durations`)
})

Deno.test(`atFps reads every still of a concat list at 30 fps, once per file`, () => {
  assertEquals(
    atFps(
      `file 'a.jpg'\nduration 1\nfile 'b.jpg'\noption framerate 30\nduration 1\nfile 'b.jpg'\n`,
    ),
    `file 'a.jpg'\noption framerate 30\nduration 1\n` +
      `file 'b.jpg'\noption framerate 30\nduration 1\nfile 'b.jpg'\noption framerate 30\n`,
  )
})

Deno.test(`encodeCommand passes -threads to ffmpeg only when asked`, () => {
  const encode = { inputs: [`-i`, `take.mp4`], graph: `[0:v]null[v]`, seconds: 5 }
  const two = encodeCommand({ ...encode, threads: 2 }, [`-c:v`, `libx264`], `demo.mp4`)
  assertEquals(two.slice(-5), [`-threads`, `2`, `-c:v`, `libx264`, `demo.mp4`])
  assertEquals(encodeCommand(encode, [], `demo.mp4`).includes(`-threads`), false)
})

/** Runs a command and returns its output; throws when it fails, so a missing ffmpeg fails loudly. */
async function sh(command: string[]): Promise<string> {
  const result = await new Deno.Command(command[0], { args: command.slice(1) }).output()
  const text = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr)
  if (!result.success) throw new Error(`${command[0]} failed: ${text.slice(-2000)}`)
  return text
}

/** The mean luma and blue-difference of every frame of a video, in order. */
async function frames(file: string): Promise<{ y: number; u: number }[]> {
  const log = await sh([`ffmpeg`, `-hide_banner`, `-i`, file, `-vf`, `showinfo`, `-f`, `null`, `-`])
  return [...log.matchAll(/mean:\[(\d+) (\d+) \d+\]/g)].map((m) => ({ y: +m[1], u: +m[2] }))
}

Deno.test({
  name: `encodeDemo turns a concat list of stills into a TV-range video that ends on the end card`,
  // ffmpeg and fontconfig are required: without them the encode throws and this test fails.
  sanitizeResources: false,
  fn: async (t) => {
    const dir = await Deno.makeTempDir({ prefix: `encode-test-` })
    try {
      const still = (colour: string) =>
        sh([`ffmpeg`, `-v`, `error`, `-y`, `-f`, `lavfi`, `-i`, `color=c=${colour}:s=320x200`]
          .concat([`-frames:v`, `1`, `${dir}/${colour}.jpg`]))
      for (const colour of [`red`, `lime`, `blue`, `white`]) await still(colour)
      // 1 s red, 12 stills of 1/30 s alternating lime and blue (a fast screencast), 2.1 s white:
      // the take lasts 3.5 s, so the video is 2 + 3.5 + 2 s.
      const fast = Array.from({ length: 12 }, (_, i) => [
        `file '${i % 2 ? `blue` : `lime`}.jpg'`,
        `duration 0.0333333`,
      ])
      const list = [`file 'red.jpg'`, `duration 1`, ...fast.flat(), `file 'white.jpg'`]
        .concat([`duration 2.1000004`, `file 'white.jpg'`])
      await Deno.writeTextFile(`${dir}/frames.txt`, list.join(`\n`) + `\n`)
      await Deno.mkdir(`${dir}/out`)
      await sh(
        [`ffmpeg`, `-v`, `error`, `-f`, `lavfi`, `-i`, `sine=f=220:d=12`, `-af`, `volume=0.1`]
          .concat([`-c:a`, `libopus`, `${dir}/out/music.opus`]),
      )
      await Deno.writeTextFile(`${dir}/out/captions.vtt`, `WEBVTT\n\n00:02.000 --> 00:04.500\nHi\n`)

      const summary = await encodeDemo({
        take: `${dir}/frames.txt`,
        out: `${dir}/out`,
        title: `demo`,
        claim: `A test`,
        end: `example.com`,
        size: { width: 320, height: 200 },
        threads: 2,
      })
      const mp4 = `${dir}/out/demo.mp4`
      const video = await frames(mp4)

      await t.step(`its length comes from the concat list's durations`, () => {
        assertEquals(summary.seconds.toFixed(2), `7.50`)
        assertEquals(video.length, 225)
      })
      await t.step(`the end card shows for its full 2 s after the last still`, () => {
        assertEquals(video[164].y > 200, true, `the take's last frame is white`)
        assertEquals(
          video.slice(165).every((frame) => frame.y < 40),
          true,
          `frames 165-224 are ink`,
        )
      })
      await t.step(`the MP4 is yuv420p in TV range`, async () => {
        const stream = await sh([`ffprobe`, `-v`, `error`, `-select_streams`, `v`, `-show_entries`]
          .concat([`stream=pix_fmt,color_range`, `-of`, `csv=p=0`, mp4]))
        assertEquals(stream.trim(), `yuv420p,tv`)
        assertEquals(video[164].y <= 236, true, `white is 235 in TV range, not 255`)
      })
      await t.step(`stills shown for 1/30 s each keep their order`, () => {
        const fast = video.slice(90, 102).map((frame) => frame.u > 160 ? `blue` : `lime`)
        assertEquals(fast, Array.from({ length: 12 }, (_, i) => i % 2 ? `blue` : `lime`))
      })
    } finally {
      await Deno.remove(dir, { recursive: true })
    }
  },
})
