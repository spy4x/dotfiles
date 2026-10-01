import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1.0.19"
import {
  bootstrap,
  bootstrapDifference,
  crossesZero,
  mean,
  median,
  quantileSorted,
  seededRandom,
} from "./stats.ts"

const t = Deno.test

t(`median averages the middle two of an even count and is undefined when empty`, () => {
  assertEquals(median([3, 1, 2]), 2)
  assertEquals(median([4, 1, 3, 2]), 2.5)
  assertEquals(median([]), undefined)
})

t(`mean of an empty list is undefined`, () => {
  assertEquals(mean([1, 2, 6]), 3)
  assertEquals(mean([]), undefined)
})

t(`quantile interpolates linearly between the two nearest ranks`, () => {
  assertEquals(quantileSorted([10, 20, 30, 40], 0), 10)
  assertEquals(quantileSorted([10, 20, 30, 40], 1), 40)
  assertAlmostEquals(quantileSorted([10, 20, 30, 40], 0.5), 25)
  assertAlmostEquals(quantileSorted([10, 20, 30, 40], 0.25), 17.5)
})

t(`the seeded generator repeats its sequence for one seed and differs for another`, () => {
  const a = seededRandom(42)
  assertEquals([a(), a(), a()], [0.6011037519201636, 0.44829055899754167, 0.8524657934904099])
  assertEquals(seededRandom(42)(), 0.6011037519201636)
  assertEquals(seededRandom(43)() === 0.6011037519201636, false)
})

t(`bootstrap of a median on a fixed seed gives the pinned interval`, () => {
  const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  assertEquals(bootstrap(data, median, { seed: 7, iterations: 1000 }), {
    value: 5.5,
    lo: 3,
    hi: 8,
  })
})

t(`bootstrap of a mean on a fixed seed gives the pinned interval`, () => {
  const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const got = bootstrap(data, mean, { seed: 7, iterations: 1000 })!
  assertEquals(got.value, 5.5)
  assertAlmostEquals(got.lo, 3.6975, 1e-9)
  assertAlmostEquals(got.hi, 7.2, 1e-9)
})

t(`bootstrap gives the same interval on every run with one seed`, () => {
  const data = [3, 1, 4, 1, 5, 9, 2, 6]
  assertEquals(bootstrap(data, median, { seed: 5 }), bootstrap(data, median, { seed: 5 }))
})

t(`bootstrap of identical values collapses to that value`, () => {
  assertEquals(bootstrap([4, 4, 4], median, { seed: 1, iterations: 200 }), {
    value: 4,
    lo: 4,
    hi: 4,
  })
})

t(`bootstrap of an empty sample is undefined`, () => {
  assertEquals(bootstrap([], median), undefined)
})

t(`bootstrapDifference on a fixed seed gives the pinned interval for unequal groups`, () => {
  assertEquals(
    bootstrapDifference([1, 2, 3, 4, 5], [4, 5, 6, 7, 8, 9], median, { seed: 7, iterations: 1000 }),
    { value: 3.5, lo: 0.5, hi: 6 },
  )
})

t(`bootstrapDifference is undefined when either group is empty`, () => {
  assertEquals(bootstrapDifference([], [1], median), undefined)
  assertEquals(bootstrapDifference([1], [], median), undefined)
})

t(`crossesZero is true when zero lies inside the interval, ends included`, () => {
  assertEquals(crossesZero({ value: 1, lo: -0.5, hi: 2 }), true)
  assertEquals(crossesZero({ value: 1, lo: 0, hi: 2 }), true)
  assertEquals(crossesZero({ value: 1, lo: 0.1, hi: 2 }), false)
  assertEquals(crossesZero({ value: -1, lo: -2, hi: -0.1 }), false)
})
