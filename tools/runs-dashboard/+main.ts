#!/usr/bin/env -S deno run --allow-net=127.0.0.1 --allow-read --allow-env --allow-ffi
// The run dashboard: `deno task runs-dashboard`, then open http://127.0.0.1:8787. Read-only.
// It serves on 127.0.0.1 only, until Ctrl+C. See README.md beside this file.

import { join } from "jsr:@std/path@^1.0.0"
import { processEnv, runtimeFileSystem } from "@spy4x/platform/server"
import { createHandler } from "./server.ts"

const home = processEnv.get(`AGENT_RUN_HOME`) ??
  join(processEnv.get(`HOME`) ?? ``, `.local`, `state`, `agent-run`)
const port = Number(processEnv.get(`PORT`) ?? 8787)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`PORT must be a port number`)
}
const dbPath = join(home, `runs.sqlite`)

// @spy4x/platform has no HTTP server adapter yet, so the entry calls Deno.serve; the handler is a
// plain fetch handler that any runtime can serve.
Deno.serve(
  {
    hostname: `127.0.0.1`,
    port,
    onListen: () => console.log(`Agent runs: http://127.0.0.1:${port} (reads ${dbPath})`),
  },
  createHandler({
    dbPath,
    port,
    exists: (path) => runtimeFileSystem.exists(path),
    readText: async (path) => {
      const text = await runtimeFileSystem.readText(path)
      if (text === null) throw new Error(`Tailwind's stylesheet is missing at ${path}`)
      return text
    },
  }),
)
