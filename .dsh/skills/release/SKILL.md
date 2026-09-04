---
name: release
description: GitHub release from commits since last tag. Angular-grouped notes with full PR URLs.
user-invocable: true
disable-model-invocation: true
license: MIT
---

# /release

/release $ARGUMENTS

Goal: GitHub release from commits since last tag. Angular-grouped notes.

Steps:
1. Parse version from args. If absent, ask. Format: vX.Y.Z (semver). Pre-release: vX.Y.Z-rc.N.
2. Find last tag: git describe --tags --abbrev=0. List commits: git log <last-tag>..HEAD --oneline.
3. Group commits by Angular type (feat/fix/refactor/perf/docs/chore/ci).
4. Filter: skip chore unless user-facing. Include breaking changes in dedicated section.
5. Draft notes:
   # <version>
   ## Breaking Changes
   - <item> ([#<pr>](https://github.com/<owner>/<repo>/pull/<pr>))
   ## Features
   - <item> ([#<pr>])
   ## Fixes
   - <item> ([#<pr>])
   ## Other
   - <item> ([#<pr>])
   PR links must be full URLs per AGENTS.md.
6. Show draft to user. Confirm: title, notes, pre-release flag, target branch (default main).
7. Create: gh release create <version> --title "<version>" --notes "..." [--prerelease] [--target <branch>]
8. Output release URL. Suggest: bump version in package.json/deno.jsonc if tracked, announce in changelog.

Caveman. PR links mandatory. User confirms before publish.

## Invocation

User types `/<name> $ARGUMENTS` in the DSH composer. DSH loads this skill's
content as a `<system-reminder>` for the next model step. The `$ARGUMENTS`
token above is replaced by the user's typed arguments.
