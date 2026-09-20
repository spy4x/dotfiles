---
name: release
description: Cut a GitHub release from commits since the last tag, notes grouped by Angular type with full PR URLs. Confirms before publishing.
argument-hint: "<vX.Y.Z | vX.Y.Z-rc.N>"
disable-model-invocation: true
---

# /release $ARGUMENTS

1. Version = `$ARGUMENTS` (`vX.Y.Z`, pre-release `vX.Y.Z-rc.N`). Absent → propose one from the
   commit types since the last tag (breaking → major, `feat` → minor, else patch) and ask.
2. `git describe --tags --abbrev=0`, then `git log <tag>..HEAD --oneline`. No tag → all history.
3. Group by Angular type. Skip `chore`/`ci`/`style` unless user-facing. Breaking changes get their
   own section, first.
4. Draft:

   ```
   # <version>
   ## Breaking Changes
   - <item> ([#<n>](https://github.com/<owner>/<repo>/pull/<n>))
   ## Features
   ## Fixes
   ## Other
   ```

   PR links are full URLs. Empty sections are dropped.
5. Pre-flight: default branch is green in CI; version in `deno.jsonc`/`package.json` (if tracked)
   matches; for JSR packages, every `<pkg>/deno.json` version that changed is bumped.
6. Show the draft + target branch + pre-release flag. **Wait for an explicit yes.**
7. `gh release create <version> --title "<version>" --notes-file <file> [--prerelease] [--target <branch>]`.
8. Print the release URL.
