/**
 * Shared utilities for dotfiles installation scripts
 */

export type PackageManager = "zypper" | "dnf" | "apt" | "winget" | "homebrew"

export interface CommandResult {
  success: boolean
  stdout: string
  stderr: string
  code: number
}

/**
 * Run a command and return the result
 */
export async function runCommand(command: string[]): Promise<CommandResult> {
  try {
    const cmd = new Deno.Command(command[0], {
      args: command.slice(1),
      stdout: "piped",
      stderr: "piped",
    })

    const { success, code, stdout, stderr } = await cmd.output()

    return {
      success,
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    }
  } catch (error) {
    return {
      success: false,
      code: -1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Run a shell command (bash -c "command")
 */
export async function runShellCommand(command: string): Promise<CommandResult> {
  return runCommand(["bash", "-c", command])
}

/**
 * Detect the package manager for the current OS
 */
export async function detectPackageManager(): Promise<PackageManager | null> {
  const os = Deno.build.os

  if (os === "linux") {
    // Try to detect package manager by existence in PATH
    for (const mgr of ["zypper", "dnf", "apt"]) {
      const result = await runCommand(["which", mgr])
      if (result.success) {
        return mgr as PackageManager
      }
    }
  } else if (os === "windows") {
    return "winget"
  } else if (os === "darwin") {
    return "homebrew"
  }

  return null
}

/**
 * Check if a file exists
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Check if a directory exists
 */
export async function directoryExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path)
    return stat.isDirectory
  } catch {
    return false
  }
}

/**
 * Check if a command is available in PATH
 */
export async function commandExists(command: string): Promise<boolean> {
  const result = await runCommand(["which", command])
  return result.success
}

/**
 * Install packages using the detected package manager
 */
export async function installPackages(
  packageManager: PackageManager,
  packages: string[],
): Promise<CommandResult & { alreadyInstalled?: string[]; newlyInstalled?: string[] }> {
  if (packages.length === 0) {
    return {
      success: true,
      code: 0,
      stdout: "",
      stderr: "",
      alreadyInstalled: [],
      newlyInstalled: [],
    }
  }

  let command: string[]

  switch (packageManager) {
    case "zypper":
      command = ["sudo", "zypper", "install", "-y", ...packages]
      break
    case "dnf":
      command = ["sudo", "dnf", "install", "-y", ...packages]
      break
    case "apt":
      command = ["sudo", "apt", "install", "-y", ...packages]
      break
    case "winget": {
      // winget doesn't support batch installation, so install one by one
      const newlyInstalled: string[] = []
      const alreadyInstalled: string[] = []

      for (const pkg of packages) {
        const result = await runCommand(["winget", "install", "--silent", pkg])
        if (result.success) {
          if (
            result.stdout.includes("already installed") ||
            result.stdout.includes("No applicable update found")
          ) {
            alreadyInstalled.push(pkg)
          } else {
            newlyInstalled.push(pkg)
          }
        } else {
          return { ...result, alreadyInstalled, newlyInstalled }
        }
      }
      return { success: true, code: 0, stdout: "", stderr: "", alreadyInstalled, newlyInstalled }
    }
    case "homebrew":
      command = ["brew", "install", ...packages]
      break
    default:
      return {
        success: false,
        code: -1,
        stdout: "",
        stderr: `Unsupported package manager: ${packageManager}`,
      }
  }

  const result = await runCommand(command)

  // Parse output to determine installation status
  const alreadyInstalled: string[] = []
  const newlyInstalled: string[] = []

  if (result.success) {
    if (packageManager === "dnf") {
      // Parse DNF output for specific package status
      for (const pkg of packages) {
        if (
          result.stdout.includes(`Installing : ${pkg}`) ||
          result.stdout.includes(`Upgrading  : ${pkg}`) ||
          result.stdout.includes(`Installed:`) && result.stdout.includes(pkg)
        ) {
          newlyInstalled.push(pkg)
        } else if (
          result.stdout.includes(`Package ${pkg}`) && result.stdout.includes("already installed") ||
          result.stderr.includes(`Package ${pkg}`) && result.stderr.includes("already installed") ||
          result.stdout.includes("Nothing to do") && packages.length === 1
        ) {
          alreadyInstalled.push(pkg)
        } else {
          // Check if package is actually installed by querying DNF
          const checkResult = await runCommand(["dnf", "list", "installed", pkg])
          if (checkResult.success) {
            alreadyInstalled.push(pkg)
          } else {
            newlyInstalled.push(pkg) // Default assumption if we can't determine status
          }
        }
      }
    } else if (packageManager === "apt") {
      // APT shows specific messages for already installed packages
      for (const pkg of packages) {
        if (
          result.stdout.includes(`${pkg} is already the newest version`) ||
          result.stdout.includes(`${pkg} set to manually installed`)
        ) {
          alreadyInstalled.push(pkg)
        } else {
          newlyInstalled.push(pkg)
        }
      }
    } else if (packageManager === "homebrew") {
      // Homebrew shows "already installed" message
      for (const pkg of packages) {
        if (result.stdout.includes(`${pkg}: already installed`)) {
          alreadyInstalled.push(pkg)
        } else {
          newlyInstalled.push(pkg)
        }
      }
    } else {
      // Default for other package managers
      newlyInstalled.push(...packages)
    }
  }

  return { ...result, alreadyInstalled, newlyInstalled }
}

/**
 * Update package manager repositories
 */
export async function updatePackageManager(packageManager: PackageManager): Promise<CommandResult> {
  let command: string[]

  switch (packageManager) {
    case "zypper":
      command = ["sudo", "zypper", "refresh"]
      break
    case "dnf":
      command = ["sudo", "dnf", "check-update"]
      break
    case "apt":
      command = ["sudo", "apt", "update"]
      break
    case "winget":
      command = ["winget", "source", "update"]
      break
    case "homebrew":
      command = ["brew", "update"]
      break
    default:
      return {
        success: false,
        code: -1,
        stdout: "",
        stderr: `Unsupported package manager: ${packageManager}`,
      }
  }

  return runCommand(command)
}
