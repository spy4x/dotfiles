#!/usr/bin/env -S deno run --allow-net=127.0.0.1 --allow-read --allow-env
// The run dashboard: `deno task runs-dashboard`, then open http://127.0.0.1:8787. Read-only.
// It serves on 127.0.0.1 only, until Ctrl+C. See README.md beside this file.

import { join } from "jsr:@std/path@^1.0.0"
import { processEnv, runtimeFileSystem } from "@spy4x/platform/server"
import { serve } from "@spy4x/platform/server/serve"
import { createHandler } from "./server.ts"

const home = processEnv.get(`AGENT_RUN_HOME`) ??
  join(processEnv.get(`HOME`) ?? ``, `.local`, `state`, `agent-run`)
const port = Number(processEnv.get(`PORT`) ?? 8787)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`PORT must be a port number`)
}
const dbPath = join(home, `runs.sqlite`)
// Extra Host values, comma-separated, for a proxy that forwards a public name (README.md).
const allowedHosts = (processEnv.get(`ALLOWED_HOSTS`) ?? ``).split(`,`).map((host) => host.trim())
  .filter(Boolean)

const server = await serve(
  createHandler({
    dbPath,
    port,
    allowedHosts,
    exists: (path) => runtimeFileSystem.exists(path),
    readText: async (path) => {
      const text = await runtimeFileSystem.readText(path)
      if (text === null) throw new Error(`Tailwind's stylesheet is missing at ${path}`)
      return text
    },
  }),
  {
    hostname: `127.0.0.1`,
    port,
    onListen: () => console.log(`Agent runs: http://127.0.0.1:${port} (reads ${dbPath})`),
  },
)
await server.finished
