---
name: shared-libs
description: "How to search the shared libraries ts-libs and preact-components (export lists and exact signatures), what belongs in which, why reusable code is born in the library first, and how a consumer takes a fresh release. Load in any spy4x TypeScript repo before you write a component, helper or library, before you add to ts-libs or preact-components, and before a consumer imports a new library release."
---

# Shared libraries

Part of the global rules (`AGENTS.md`, "Stack", "Shared libs before local code"); they bind as if
written there.

## Search

Grep both export lists for the thing under several names. Never read them whole (over 100,000
tokens). The fetch may fail (an SSH agent without a key); the grep then runs on the last fetched
`origin/main`:

```bash
git -C ~/sync/code/ts-libs fetch -q 2>/dev/null; git -C ~/sync/code/ts-libs grep -n -i '<word>' origin/main -- llms.txt
```

The same in `~/sync/code/preact-components`. No local checkout → download
`https://raw.githubusercontent.com/spy4x/<repo>/main/llms.txt` to a file and grep that. For an
export's exact signature, from the package and entry in its import specifier:

```bash
NO_COLOR=1 deno doc --minimum-dependency-age=0 --filter <Name> jsr:@spy4x/<pkg>@<version>/<entry>
```

`deno doc` ignores that flag for a version published less than a day ago: run it then from a
folder whose `deno.json` holds `{ "minimumDependencyAge": "0" }`.

## What goes where

- `preact-components`: Preact components, icons, design tokens, signals helpers.
- `ts-libs`: code with no UI that a server or a page could use: date and time, formatting, parsing,
  validation, security, networking, integrations.
- Neither: business wording, one app's data model, or a renamed copy of something that exists. That
  stays in the app.

## Library first, never "move it later"

Reusable code is born in the library. Never write a local version in a consumer repo (seed, financy,
mig and the rest) and file an issue to move it later: that step is how copies pile up. Make the
library change first, in the library's own worktree, by you or a subagent. Review, merge and release
it there, then import the released version in the consumer. A consumer change that needs a library
change waits for that release; it never ships a local stand-in. If the library change is blocked on
a decision, the consumer change is blocked too.

Both ways: an app feeds the libraries, and every app, old or new, imports from them instead of
keeping its own copy. Details: each library's `AGENTS.md`, "What belongs in this library".

Never hold a reviewed merge or deploy for Deno's 24-hour minimum dependency age on a fresh library
release, and never add a flag or wording to hide it. Write the consumer's lockfile once with `deno
install --minimum-dependency-age=0` and commit it; CI then resolves the version from `deno.lock`.
