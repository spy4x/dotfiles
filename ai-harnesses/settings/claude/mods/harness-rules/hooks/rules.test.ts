import { expect, test } from "claude-code/testing"
import { bashVerdict, ghPost, leakVerdict, markerVerdict, spawnVerdict } from "./rules.ts"

const opusReviewer = { subagentType: `reviewer`, model: `opus`, fork: false }

test(`refuses a spawn without a model`, () => {
  expect(spawnVerdict({ subagentType: `Explore`, fork: false }, 10).deny).toContain(`model`)
})

test(`lets a fork inherit its parent's model`, () => {
  expect(spawnVerdict({ subagentType: `fork`, fork: true }, 10).deny).toBeUndefined()
})

test(`refuses a reviewer on sonnet and allows one on opus`, () => {
  expect(spawnVerdict({ ...opusReviewer, model: `sonnet` }, 10).deny).toContain(`opus`)
  expect(spawnVerdict(opusReviewer, 10).deny).toBeUndefined()
  expect(spawnVerdict({ ...opusReviewer, model: `claude-opus-5-5` }, 10).deny).toBeUndefined()
})

test(`refuses every spawn at 90% of the 5-hour limit, forks included`, () => {
  expect(spawnVerdict(opusReviewer, 89.9).deny).toBeUndefined()
  expect(spawnVerdict(opusReviewer, 90).deny).toContain(`5-hour`)
  expect(spawnVerdict({ subagentType: `fork`, fork: true }, 95).deny).toContain(`5-hour`)
})

test(`allows a spawn when there is no 5-hour reading`, () => {
  expect(spawnVerdict(opusReviewer, undefined).deny).toBeUndefined()
})

test(`refuses a recursive rm of a variable path, sudo or not`, () => {
  expect(bashVerdict(`rm -rf "$D"`).deny).toContain(`rm -r`)
  expect(bashVerdict(`cd x && sudo -n rm -r $TMP/a`).deny).toContain(`rm -r`)
  expect(bashVerdict(`rm --recursive \${DIR}`).deny).toContain(`rm -r`)
  expect(bashVerdict(`rm -fR "$D"`).deny).toContain(`rm -r`)
})

test(`allows rm of a literal path and a plain rm of a variable file`, () => {
  expect(bashVerdict(`rm -rf /tmp/claude-1000/x`).deny).toBeUndefined()
  expect(bashVerdict(`rm -f "$FILE"`).deny).toBeUndefined()
  expect(bashVerdict(`find "$D" -delete`).deny).toBeUndefined()
})

test(`refuses find / and allows find in a directory`, () => {
  expect(bashVerdict(`find / -name x`).deny).toContain(`find /`)
  expect(bashVerdict(`ls; sudo find / -name x`).deny).toContain(`find /`)
  expect(bashVerdict(`find /home/spy4x -name x`).deny).toBeUndefined()
})

test(`finds the body a gh command posts`, () => {
  expect(ghPost(`gh pr create --title t --body-file /tmp/b.md`)).toEqual({
    kind: `file`,
    path: `/tmp/b.md`,
  })
  expect(ghPost(`gh pr create -F "/tmp/a b.md"`)).toEqual({ kind: `file`, path: `/tmp/a b.md` })
  expect(ghPost(`gh issue comment 5 --body "hi"`)).toEqual({ kind: `inline` })
  expect(ghPost(`gh pr review 5 --approve -b ok`)).toEqual({ kind: `inline` })
})

test(`sees no body in a title-only edit, a --fill PR or another gh command`, () => {
  expect(ghPost(`gh pr edit 5 --title x`)).toEqual({ kind: `none` })
  expect(ghPost(`gh pr create --fill --base main`)).toEqual({ kind: `none` })
  expect(ghPost(`gh pr view 5 --json body`)).toEqual({ kind: `none` })
  expect(ghPost(`gh api repos/a/b -F x=1`)).toEqual({ kind: `none` })
})

test(`requires the agent marker in a body`, () => {
  expect(markerVerdict(`<!-- agent -->\nhello`).deny).toBeUndefined()
  expect(markerVerdict(`hello`).deny).toContain(`<!-- agent -->`)
})

test(`refuses a body gitleaks flags and one it failed to scan`, () => {
  expect(leakVerdict(0).deny).toBeUndefined()
  expect(leakVerdict(1).deny).toContain(`secret`)
  expect(leakVerdict(127).deny).toContain(`failed`)
})
