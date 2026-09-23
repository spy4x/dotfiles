import { assertEquals } from "jsr:@std/assert@1.0.19"
import { dirname, join, relative } from "jsr:@std/path@^1.0.0"
import { ADAPTERS, loadConfig } from "./engine.ts"
import { HARNESSES } from "./schema.ts"
import { listFiles, loadSource } from "./source.ts"

/**
 * Golden files: each adapter renders `fixtures/source` and must match `fixtures/golden/<harness>`
 * byte for byte, file list included. After an intended change, regenerate with
 * `deno test -A ai-harnesses/adapters.test.ts -- --update` and review the diff.
 */
const FIXTURES = join(import.meta.dirname!, `fixtures`)
const UPDATE = Deno.args.includes(`--update`)

const config = await loadConfig(join(FIXTURES, `config.jsonc`))
const source = await loadSource(join(FIXTURES, `source`))

for (const harness of HARNESSES) {
  Deno.test(`${harness} renders the fixture source exactly as the golden files`, async () => {
    const rendered = ADAPTERS[harness].render(source, config.harnesses[harness])
    const golden = join(FIXTURES, `golden`, harness)
    if (UPDATE) {
      await Deno.remove(golden, { recursive: true }).catch(() => {})
      for (const file of rendered) {
        await Deno.mkdir(dirname(join(golden, file.path)), { recursive: true })
        await Deno.writeTextFile(join(golden, file.path), file.content)
      }
    }
    const expected = await listFiles(golden)
    assertEquals(
      rendered.map((file) => file.path).sort(),
      expected.map((path) => relative(golden, path)),
      `rendered file list differs from golden`,
    )
    for (const file of rendered) {
      assertEquals(file.content, await Deno.readTextFile(join(golden, file.path)), file.path)
    }
  })
}

Deno.test(`settings named in merge are merged, everything else is copied`, () => {
  const kinds = (harness: typeof HARNESSES[number]) =>
    Object.fromEntries(
      ADAPTERS[harness].render(source, config.harnesses[harness])
        .filter((file) => file.path.includes(`.json`) || file.path.includes(`.y`))
        .filter((file) => !file.path.startsWith(`.agent-presets/`))
        .map((file) => [file.path, file.merge ?? `copy`]),
    )
  assertEquals(kinds(`claude`), { "settings.json": `json` })
  assertEquals(kinds(`opencode`), { "opencode.json": `json` })
  assertEquals(kinds(`dsh`), { "settings.yaml": `yaml`, "profiles/web/cordis.patch.yml": `copy` })
})

Deno.test(`hook scripts ship only while the tracked Claude settings wire them up`, () => {
  const paths = (settings: string) =>
    ADAPTERS.claude.render(
      {
        ...source,
        settings: {
          ...source.settings,
          claude: [
            { path: `settings.json`, content: settings },
            { path: `hooks/guard.ts`, content: `// hook\n` },
          ],
        },
      },
      config.harnesses.claude,
    ).map((file) => file.path)
  assertEquals(paths(`{}`).includes(`hooks/guard.ts`), false)
  assertEquals(paths(`{"hooks":{"PreToolUse":[]}}`).includes(`hooks/guard.ts`), true)
})
