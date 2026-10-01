/** Runs `command` with `args` and resolves with its stdout; rejects when it exits non-zero. */
export type Exec = (command: string, args: string[]) => Promise<string>

/** A command that failed to start or exited non-zero. */
export class CommandError extends Error {
  constructor(readonly command: string, readonly args: string[], detail: string) {
    super(`\`${[command, ...args].join(` `)}\` failed: ${detail}`)
    this.name = `CommandError`
  }
}

/** The real `Exec`: spawns the process with `Deno.Command`. */
export const denoExec: Exec = async (command, args) => {
  let output: Deno.CommandOutput
  try {
    output = await new Deno.Command(command, { args, stdout: `piped`, stderr: `piped` }).output()
  } catch (error) {
    throw new CommandError(command, args, String(error))
  }
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim()
    throw new CommandError(command, args, `exit ${output.code}: ${stderr.slice(0, 300)}`)
  }
  return new TextDecoder().decode(output.stdout)
}
