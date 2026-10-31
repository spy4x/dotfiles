import { expect, test } from "claude-code/testing"
import {
  bashVerdict,
  bodyFilePath,
  directionBlock,
  ghPost,
  leakVerdict,
  markerVerdict,
  spawnVerdict,
  uuidVerdict,
} from "./rules.ts"

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

test(`refuses an implementer or a design reviewer on sonnet and allows them on opus`, () => {
  for (const subagentType of [`implementer`, `implementer-xhigh`, `design-reviewer`]) {
    expect(spawnVerdict({ subagentType, model: `sonnet`, fork: false }, 10).deny).toContain(`opus`)
    expect(spawnVerdict({ subagentType, model: `opus`, fork: false }, 10).deny).toBeUndefined()
  }
  expect(spawnVerdict({ subagentType: `Explore`, model: `haiku`, fork: false }, 10).deny)
    .toBeUndefined()
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

test(`resolves a body-file path through a variable the same command set`, () => {
  expect(ghPost(`D=/tmp/x && gh pr edit 5 --body-file $D/b.md`)).toEqual({
    kind: `file`,
    path: `/tmp/x/b.md`,
  })
  expect(ghPost(`S=/tmp/s; cd /w && gh issue create -F "\${S}/i.md"`)).toEqual({
    kind: `file`,
    path: `/tmp/s/i.md`,
  })
  expect(ghPost(`gh pr edit 5 --body-file $UNSET/b.md`)).toEqual({
    kind: `file`,
    path: `$UNSET/b.md`,
  })
  expect(ghPost(`D=$(mktemp -d) && gh pr edit 5 --body-file $D/b.md`)).toEqual({
    kind: `file`,
    path: `$D/b.md`,
  })
})

test(`leaves a variable unresolved when the command may change it or never set it`, () => {
  for (
    const command of [
      `D=/tmp/good && D=$(mktemp -d) && gh pr comment 5 --body-file $D/b.md`,
      `D=/tmp/good && D+=/x && gh pr comment 5 --body-file $D/b.md`,
      `D=/tmp/good && read D < p && gh pr comment 5 --body-file $D/b.md`,
      `echo D=/tmp/good; gh pr comment 5 --body-file $D/b.md`,
      `D=/tmp/good X=1 cat f; gh pr comment 5 --body-file $D/b.md`,
      `D=/tmp/good && D[0]=/tmp/bad && gh pr comment 5 --body-file $D/b.md`,
      `D=/tmp/good && eval D\\=/tmp/bad && gh pr comment 5 --body-file $D/b.md`,
    ]
  ) expect(ghPost(command)).toEqual({ kind: `file`, path: `$D/b.md` })
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

test(`finds a gh post after wrappers, assignments and loop words`, () => {
  for (
    const command of [
      `timeout 30 gh pr comment 5 --body x`,
      `X=1 gh pr comment 5 --body x`,
      `sudo -n gh pr comment 5 --body x`,
      `env GH_HOST=h gh pr comment 5 --body x`,
      `nice -n 10 gh pr comment 5 --body x`,
      `echo 5 | xargs -n 1 gh pr comment 5 --body x`,
      `for i in 1; do gh pr comment 5 --body x; done`,
      `if true; then gh pr comment 5 --body x; fi`,
      `/usr/bin/gh pr comment 5 --body x`,
      `\\gh pr comment 5 --body x`,
    ]
  ) expect(ghPost(command)).toEqual({ kind: `inline`, body: `x` })
})

test(`refuses to place a gh post it cannot read`, () => {
  for (
    const command of [
      `bash -c 'gh pr comment 5 --body x'`,
      `bash -c 'gh -R a/b pr comment 5 -bx'`,
      `echo "$(gh issue create --title t --body x)"`,
      `xargs -I {} gh pr comment {} --body x`,
      `stdbuf -oL gh pr comment 5 --body-file /abs/b.md`,
      `gh pr comment 1 --body "<!-- agent --> a"; gh pr comment 2 --body b`,
    ]
  ) expect(ghPost(command)).toEqual({ kind: `unplaced` })
})

test(`finds a gh post after global flags and with a short flag's value attached`, () => {
  for (
    const command of [
      `gh -R a/b pr comment 5 --body x`,
      `gh --repo a/b issue comment 1 --body x`,
      `gh --repo=a/b pr comment 5 --body x`,
      `gh pr comment 5 -bx`,
      `gh pr comment 5 -wb x`,
    ]
  ) expect(ghPost(command)).toEqual({ kind: `inline`, body: `x` })
  expect(ghPost(`gh pr comment 5 -F/abs/f`)).toEqual({ kind: `file`, path: `/abs/f` })
  expect(ghPost(`gh pr comment 5 -Ff.md`)).toEqual({ kind: `file`, path: `f.md` })
})

test(`drops the = of a short flag's attached value, as gh does`, () => {
  expect(ghPost(`gh pr comment 5 -F=/abs/f.md`)).toEqual({ kind: `file`, path: `/abs/f.md` })
  expect(ghPost(`gh pr comment 5 -b=x`)).toEqual({ kind: `inline`, body: `x` })
  expect(ghPost(`gh pr comment 5 -wb=x`)).toEqual({ kind: `inline`, body: `x` })
})

test(`finds the comment a close posts and the body a merge posts`, () => {
  expect(ghPost(`gh issue close 1 --comment x`)).toEqual({ kind: `inline`, body: `x` })
  expect(ghPost(`gh pr close 1 -c x`)).toEqual({ kind: `inline`, body: `x` })
  expect(ghPost(`gh issue close 1 -r completed --comment=x`)).toEqual({ kind: `inline`, body: `x` })
  expect(ghPost(`gh pr merge 1 --squash --body x`)).toEqual({ kind: `inline`, body: `x` })
  expect(ghPost(`gh pr merge 1 -b x`)).toEqual({ kind: `inline`, body: `x` })
  expect(ghPost(`gh pr merge 1 --body-file /abs/b.md`)).toEqual({ kind: `file`, path: `/abs/b.md` })
  expect(ghPost(`gh pr merge 1 -F /abs/b.md`)).toEqual({ kind: `file`, path: `/abs/b.md` })
  expect(ghPost(`bash -c 'gh pr close 1 -c x'`)).toEqual({ kind: `unplaced` })
})

test(`sees no body in a close without a comment or a merge without a body`, () => {
  expect(ghPost(`gh pr merge 1 --squash --delete-branch --repo a/b`)).toEqual({ kind: `none` })
  expect(ghPost(`gh issue close 1 -r "not planned"`)).toEqual({ kind: `none` })
  expect(ghPost(`gh pr close 1 -d`)).toEqual({ kind: `none` })
})

test(`expands home in a body-file path and gives up on any other shell expansion`, () => {
  expect(bodyFilePath(`~/f.md`, { home: `/home/t` })).toBe(`/home/t/f.md`)
  expect(bodyFilePath(`$HOME/f.md`, { home: `/home/t` })).toBe(`/home/t/f.md`)
  expect(bodyFilePath(`\${HOME}/f.md`, { home: `/home/t` })).toBe(`/home/t/f.md`)
  expect(bodyFilePath(`/abs/f.md`, {})).toBe(`/abs/f.md`)
  for (
    const [path, home] of [
      [`~/f.md`, undefined],
      [`$HOME/f.md`, undefined],
      [`$FOO/f.md`, `/home/t`],
      [`$HOMEDIR/f.md`, `/home/t`],
      [`/abs/$HOME/f.md`, `/home/t`],
      [`\`pwd\`/f.md`, `/home/t`],
      [`~root/f.md`, `/home/t`],
    ]
  ) expect(bodyFilePath(path!, { home, cwd: `/w` })).toBeUndefined()
})

test(`joins a relative body-file path to the session's directory, and gives up without one`, () => {
  expect(bodyFilePath(`f.md`, { cwd: `/w` })).toBe(`/w/f.md`)
  expect(bodyFilePath(`sub/f.md`, { cwd: `/w` })).toBe(`/w/sub/f.md`)
  expect(bodyFilePath(`$HOME/x/f.md`, { cwd: `/w`, home: `/home/t` })).toBe(`/home/t/x/f.md`)
  expect(bodyFilePath(`f.md`, {})).toBeUndefined()
})

test(`resolves a relative body-file path against the folder a cd moved to`, () => {
  for (
    const [command, path] of [
      [`cd /x && gh pr comment 5 -F f.md`, `/x/f.md`],
      [`cd -- /x && gh pr comment 5 -F f.md`, `/x/f.md`],
      [`pushd /x && gh pr comment 5 -F f.md`, `/x/f.md`],
      [`cd /x; cd sub && gh pr comment 5 -F f.md`, `/x/sub/f.md`],
      [`cd sub && gh pr comment 5 -F f.md`, `sub/f.md`],
      [`cd && gh pr comment 5 -F f.md`, `$HOME/f.md`],
      [`cd ~ && gh pr comment 5 -F f.md`, `$HOME/f.md`],
      [`cd ~/x && gh pr comment 5 -F f.md`, `~/x/f.md`],
      [`cd /x && gh pr comment 5 -F /abs/f.md`, `/abs/f.md`],
      [`cd "$FOO" && gh pr comment 5 -F /abs/f.md`, `/abs/f.md`],
      [`gh pr comment 5 -F f.md && cd /x`, `f.md`],
    ]
  ) expect(ghPost(command!)).toEqual({ kind: `file`, path: path! })
})

test(`refuses a relative body file after a cd it cannot follow`, () => {
  for (
    const command of [
      `cd "$FOO" && gh pr comment 5 -F f.md`,
      `cd "$FOO" && cd sub && gh pr comment 5 -F f.md`,
      `cd "$(mktemp -d)" && gh pr comment 5 -F f.md`,
      `cd \`pwd\` && gh pr comment 5 -F f.md`,
      `cd - && gh pr comment 5 -F f.md`,
      `cd -P /x && gh pr comment 5 -F f.md`,
      `cd /x y && gh pr comment 5 -F f.md`,
      `cd /x/* && gh pr comment 5 -F f.md`,
      `cd ~root && gh pr comment 5 -F f.md`,
      `pushd +1 && gh pr comment 5 -F f.md`,
      `pushd /x && popd && gh pr comment 5 -F f.md`,
      `(cd /x) && gh pr comment 5 -F f.md`,
    ]
  ) expect(ghPost(command)).toEqual({ kind: `unplaced` })
})

test(`finds the comment a reopen posts`, () => {
  expect(ghPost(`gh issue reopen 1 --comment x`)).toEqual({ kind: `inline`, body: `x` })
  expect(ghPost(`gh pr reopen 1 -c x`)).toEqual({ kind: `inline`, body: `x` })
  expect(ghPost(`gh pr reopen 1`)).toEqual({ kind: `none` })
  expect(ghPost(`bash -c 'gh issue reopen 1 -c x'`)).toEqual({ kind: `unplaced` })
})

test(`sees a merge's commit subject as text to scan, not as a body`, () => {
  expect(ghPost(`gh pr merge 1 --squash --subject x`)).toEqual({ kind: `subject` })
  expect(ghPost(`gh pr merge 1 -t x`)).toEqual({ kind: `subject` })
  expect(ghPost(`gh pr merge 1 -t x -b y`)).toEqual({ kind: `inline`, body: `y` })
  expect(ghPost(`gh pr create -t x`)).toEqual({ kind: `none` })
})

test(`refuses a repeated body flag, since gh posts the last one`, () => {
  for (
    const command of [
      `gh pr comment 5 --body-file a.md --body-file b.md`,
      `gh pr comment 5 --body "<!-- agent --> a" -bx`,
    ]
  ) expect(ghPost(command)).toEqual({ kind: `unplaced` })
})

test(`sees no post in a wrapped gh read or a quoted gh call without a body`, () => {
  expect(ghPost(`timeout 30 gh pr view 5 --json body`)).toEqual({ kind: `none` })
  expect(ghPost(`sudo gh issue list --state open`)).toEqual({ kind: `none` })
  expect(ghPost(`bash -c 'gh pr create --fill'`)).toEqual({ kind: `none` })
})

test(`refuses rm of a variable path after nice or xargs`, () => {
  expect(bashVerdict(`nice -n 10 rm -rf "$D"`).deny).toContain(`variable`)
  expect(bashVerdict(`ls | xargs -n 1 rm -rf "$D"`).deny).toContain(`variable`)
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

test(`refuses ulimit -u in any spelling and allows other ulimit flags`, () => {
  expect(bashVerdict(`ulimit -u 500`).deny).toContain(`ulimit -u`)
  expect(bashVerdict(`ulimit -Su 500 && make`).deny).toContain(`ulimit -u`)
  expect(bashVerdict(`(ulimit -u 100; ./x)`).deny).toContain(`ulimit -u`)
  expect(bashVerdict(`ulimit -n 4096`).deny).toBeUndefined()
  expect(bashVerdict(`ulimit -a`).deny).toBeUndefined()
})

test(`refuses gh pr merge with --admin`, () => {
  expect(bashVerdict(`gh pr merge 5 --repo a/b --squash --admin`).deny).toContain(`--admin`)
})

test(`refuses gh pr merge without --repo and allows one with it`, () => {
  expect(bashVerdict(`gh pr merge 5 --squash --delete-branch`).deny).toContain(`--repo`)
  expect(bashVerdict(`gh pr merge 5 --repo a/b --squash --delete-branch`).deny).toBeUndefined()
  expect(bashVerdict(`gh pr merge 5 -R a/b --rebase`).deny).toBeUndefined()
  expect(bashVerdict(`gh pr merge 5 --repo=a/b --squash`).deny).toBeUndefined()
  expect(bashVerdict(`gh pr view 5`).deny).toBeUndefined()
})

/** The calls the id rule refuses, built from parts so this file holds none of them. */
const V4 = {
  crypto: `crypto.random` + `UUID()`,
  postgres: `gen_random` + `_uuid()`,
  extension: `uuid_generate` + `_v4()`,
  npm: `uuid` + `v4()`,
}

test(`refuses a write that adds a version 4 UUID call to a code file`, () => {
  expect(uuidVerdict(`/r/a.ts`, ``, `const id = ${V4.crypto}`).deny).toContain(`version 7`)
  expect(uuidVerdict(`/r/a.tsx`, ``, `id: ${V4.npm}`).deny).toContain(`version 7`)
  expect(uuidVerdict(`/r/m.sql`, ``, `DEFAULT ${V4.postgres}`).deny).toContain(`version 7`)
  expect(uuidVerdict(`/r/m.SQL`, ``, `DEFAULT ${V4.extension}`).deny).toContain(`version 7`)
  expect(uuidVerdict(`/r/a.mjs`, V4.crypto, `${V4.crypto}; ${V4.crypto}`).deny)
    .toContain(`version 7`)
})

test(`allows keeping an existing call and writing one outside code files`, () => {
  expect(uuidVerdict(`/r/a.ts`, `a(${V4.crypto})`, `b(${V4.crypto})`).deny).toBeUndefined()
  expect(uuidVerdict(`/r/AGENTS.md`, ``, `Never ${V4.crypto}`).deny).toBeUndefined()
  expect(uuidVerdict(`/r/a.ts`, ``, `const id = uuidV7()`).deny).toBeUndefined()
})

test(`frames direction.md as a context block and skips a missing or empty one`, () => {
  const block = directionBlock(`# Direction\n\nShip often.\n`)
  expect(block?.name).toBe(`direction`)
  expect(block?.text).toContain(`ai-memory/direction.md`)
  expect(block?.text).toContain(`Ship often.`)
  expect(directionBlock(undefined)).toBeUndefined()
  expect(directionBlock(`  \n`)).toBeUndefined()
})
