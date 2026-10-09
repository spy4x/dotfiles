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

const WHERE = { cwd: `/home/u/code/worktrees/repo/fix/x`, home: `/home/u` }

test(`refuses a recursive rm of a variable path, sudo or not`, () => {
  expect(bashVerdict(`rm -rf "$D"`).deny).toContain(`variable`)
  expect(bashVerdict(`cd x && sudo -n rm -r $TMP/a`).deny).toContain(`variable`)
  expect(bashVerdict(`rm --recursive \${DIR}`).deny).toContain(`variable`)
  expect(bashVerdict(`rm -fR "$D"`).deny).toContain(`variable`)
})

test(`refuses a plain rm or rmdir of a variable path`, () => {
  expect(bashVerdict(`rm -f "$FILE"`).deny).toContain(`find "<literal path>" -delete`)
  expect(bashVerdict(`rmdir $D`).deny).toContain(`rmdir`)
  expect(bashVerdict(`rm "$HOME"`).deny).toContain(`variable`)
})

test(`refuses rm of a command substitution`, () => {
  expect(bashVerdict(`rm -rf "$(mktemp -d)"`).deny).toContain(`command substitution`)
  expect(bashVerdict(`rm -rf $(ls x)`).deny).toContain(`command substitution`)
  expect(bashVerdict("rm -rf `pwd`/x").deny).toContain(`command substitution`)
  expect(bashVerdict(`/usr/bin/rm -f "$(cat f)"`).deny).toContain(`command substitution`)
})

test(`refuses rm of / and of a top-level directory`, () => {
  expect(bashVerdict(`rm -rf /`, WHERE).deny).toContain(`it is the root`)
  expect(bashVerdict(`rm -rf /*`, WHERE).deny).toContain(`it is the root`)
  expect(bashVerdict(`rm -rf /tmp/a/../..`).deny).toContain(`it is the root`)
  expect(bashVerdict(`rm -rf /tmp/`, WHERE).deny).toContain(`it is a top-level directory`)
  expect(bashVerdict(`rmdir /opt`).deny).toContain(`it is a top-level directory`)
})

test(`refuses rm of home, the working directory and its parents`, () => {
  expect(bashVerdict(`rm -rf ~`).deny).toContain(`it is home`)
  expect(bashVerdict(`rm -rf ~/`, WHERE).deny).toContain(`it is home`)
  expect(bashVerdict(`rm -rf /home/u`, { cwd: `/srv/app`, home: `/home/u` }).deny)
    .toContain(`it is home`)
  expect(bashVerdict(`rm -rf .`).deny).toContain(`it is the working directory`)
  expect(bashVerdict(`\\rm -rf .`).deny).toContain(`it is the working directory`)
  expect(bashVerdict(`rm -rf ./*`).deny).toContain(`it is the working directory`)
  expect(bashVerdict(`rm -rf ..`).deny).toContain(`it is a parent of the working directory`)
  expect(bashVerdict(`rm -rf /home/u/code/worktrees/repo/fix/x`, WHERE).deny)
    .toContain(`it is the working directory`)
  expect(bashVerdict(`rm -rf /home/u/code/worktrees/repo/fix/x/./`, WHERE).deny)
    .toContain(`it is the working directory`)
  expect(bashVerdict(`rm -rf ../../fix`, WHERE).deny)
    .toContain(`it is a parent of the working directory`)
  expect(bashVerdict(`rm -rf /home/u/code/worktrees`, WHERE).deny)
    .toContain(`it is a parent of the working directory`)
})

test(`reads rm after a keyword, an assignment, a group or a prefix command`, () => {
  expect(bashVerdict(`for d in a b; do rm -rf "$d"; done`).deny).toContain(`variable`)
  expect(bashVerdict(`if true; then rm -rf "$D"; fi`).deny).toContain(`variable`)
  expect(bashVerdict(`(rm -rf .)`).deny).toContain(`the working directory`)
  expect(bashVerdict(`{ rm -rf ~; }`).deny).toContain(`it is home`)
  expect(bashVerdict(`X=1 rm -rf "$D"`).deny).toContain(`variable`)
  expect(bashVerdict(`timeout -s KILL 60 rm -rf "$D"`).deny).toContain(`variable`)
  expect(bashVerdict(`sudo -u root rm -rf /opt`).deny).toContain(`top-level`)
  expect(bashVerdict(`command rm -rf /opt`).deny).toContain(`top-level`)
  expect(bashVerdict(`env X=1 nohup rm -f "$F"`).deny).toContain(`variable`)
})

test(`allows rm of a literal path below the working directory or elsewhere`, () => {
  expect(bashVerdict(`rm -rf /tmp/claude-1000/x`, WHERE).deny).toBeUndefined()
  expect(bashVerdict(`rm -rf build dist/x`, WHERE).deny).toBeUndefined()
  expect(bashVerdict(`rm -rf ../sibling`, WHERE).deny).toBeUndefined()
  expect(bashVerdict(`rm -rf /home/u/code/worktrees/repo/fix/xy`, WHERE).deny).toBeUndefined()
  expect(bashVerdict(`rm -rf /home/u/code/worktrees/repo/fi`, WHERE).deny).toBeUndefined()
  expect(bashVerdict(`rm -rf /srv/build`, WHERE).deny).toBeUndefined()
  expect(bashVerdict(`rm -f ~/notes.txt`, WHERE).deny).toBeUndefined()
  expect(bashVerdict(`find "$D" -delete`, WHERE).deny).toBeUndefined()
  expect(bashVerdict(`echo $HOME && grep -rn rm .`, WHERE).deny).toBeUndefined()
})

test(`reads ; and && inside quotes as text, not as a new command`, () => {
  expect(bashVerdict(`echo "a; rm -rf $D"`).deny).toBeUndefined()
  expect(bashVerdict(`echo 'x && find / -name y'`).deny).toBeUndefined()
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
  expect(ghPost(`gh issue comment 5 --body "hi"`)).toEqual({ kind: `inline`, body: `hi` })
  expect(ghPost(`gh pr review 5 --approve -b ok`)).toEqual({ kind: `inline`, body: `ok` })
  expect(ghPost(`gh pr edit 5 --body=x`)).toEqual({ kind: `inline`, body: `x` })
  expect(ghPost(`gh pr comment 5 --body-file - <<'X'\nhi\nX`)).toEqual({ kind: `stdin` })
})

test(`reads only the gh command's own flags, not flags elsewhere or inside quotes`, () => {
  expect(ghPost(`git checkout -b fix/x && gh pr create --fill`)).toEqual({ kind: `none` })
  expect(ghPost(`gh pr edit 118 --title "docs: explain -b usage"`)).toEqual({ kind: `none` })
  expect(ghPost(`rg -n -F 'gh pr create --fill' ai-harnesses`)).toEqual({ kind: `none` })
  expect(ghPost(`gh issue create --title "Use -F flag" --body-file /abs/b.md`)).toEqual({
    kind: `file`,
    path: `/abs/b.md`,
  })
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
