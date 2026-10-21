import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19"
import { captionProblems, type Cue, loudnessProblems, musicGain, parseVtt } from "./encode.ts"

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
