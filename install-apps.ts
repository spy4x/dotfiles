import { detectPackageManager, installPackages, runCommand } from "./shared.ts"

interface App {
  name: string
  dnf?: string[]
  apt?: string[]
  zypper?: string[]
  winget?: string[]
  homebrew?: string[]
  repo?: string // Legacy support
  repoUrl?: string // New repo URL field
  repoGpgKey?: string // GPG key for repo
  preInstallCommands?: string[]
  postInstallCommands?: string[]
  flatpak?: string
  flatpakSudo?: boolean
  requiresReboot?: boolean
  architectures?: string[] // Supported architectures (x86_64, aarch64, etc.)
}

async function runAppCommand(command: string[]): Promise<void> {
  const result = await runCommand(command)

  if (!result.success) {
    const errorMsg = `Error running command: ${
      command.join(" ")
    }\nExit Code: ${result.code}\nStderr: ${result.stderr}\nStdout: ${result.stdout}`
    console.error(errorMsg)
    throw new Error(errorMsg)
  } else {
    console.log(`Successfully ran: ${command.join(" ")}`)
    if (result.stdout) console.log(`Stdout: ${result.stdout}`)
  }
}

async function main() {
  const apps: App[] = JSON.parse(await Deno.readTextFile("apps.json"))
  let needsReboot = false

  const pkgManager = await detectPackageManager()

  if (!pkgManager) {
    console.error("Could not detect supported package manager for this OS.")
    Deno.exit(1)
  }

  console.log(`📦 Detected package manager: ${pkgManager}`)
  console.log("🚀 Starting application installation...")

  // Setup Flatpak Flathub remote if on Linux
  if (Deno.build.os === "linux") {
    console.log("🔍 Checking Flatpak Flathub remote setup...")
    const checkFlatpakRemote = await runCommand(["flatpak", "remotes", "--user"])
    if (checkFlatpakRemote.success && !checkFlatpakRemote.stdout.includes("flathub")) {
      console.log("🔧 Setting up Flathub remote for user-level Flatpak installations...")
      const addRemoteResult = await runCommand([
        "flatpak",
        "remote-add",
        "--user",
        "--if-not-exists",
        "flathub",
        "https://dl.flathub.org/repo/flathub.flatpakrepo",
      ])
      if (!addRemoteResult.success) {
        console.warn("⚠️  Failed to add Flathub remote, Flatpak installations may fail")
      } else {
        console.log("✅ Flathub remote added successfully")
        // Sync the remote to ensure metadata is available
        console.log("🔄 Syncing Flathub metadata...")
        const syncResult = await runCommand(["flatpak", "update", "--user", "--appstream"])
        if (!syncResult.success) {
          console.warn("⚠️  Failed to sync Flathub metadata, trying alternative sync method...")
          // Try alternative sync method
          const altSyncResult = await runCommand(["flatpak", "remote-ls", "--user", "flathub"])
          if (!altSyncResult.success) {
            console.warn("⚠️  Alternative sync also failed, some apps may not be found")
          }
        } else {
          console.log("✅ Flathub metadata synced successfully")
        }
      }
    } else {
      console.log("✅ Flathub remote already configured")
    }
  }

  const successApps: string[] = []
  const failedApps: { name: string; error: string }[] = []
  const skippedApps: string[] = []

  for (const app of apps) {
    console.log("\n---------------------")
    console.log(`Processing: ${app.name}`)

    // Check architecture compatibility
    if (app.architectures && app.architectures.length > 0) {
      const currentArch = Deno.build.arch === "x86_64"
        ? "x86_64"
        : Deno.build.arch === "aarch64"
        ? "aarch64"
        : Deno.build.arch

      if (!app.architectures.includes(currentArch)) {
        console.log(`⚠️  Skipping ${app.name} - not available for architecture: ${currentArch}`)
        skippedApps.push(app.name)
        continue
      }
    }

    let appFailed = false
    let errorMsg = ""

    try {
      let nativePackagesFailed = false
      let nativePackagesError = ""

      // 1. Execute pre-installation commands
      if (app.preInstallCommands && app.preInstallCommands.length > 0) {
        console.log(`🔧 Running pre-installation commands for ${app.name}:`)
        for (const command of app.preInstallCommands) {
          let expandedCommand = command
          expandedCommand = expandedCommand.replace(/\$USER/g, Deno.env.get("USER") || "")
          expandedCommand = expandedCommand.replace(/\$HOME/g, Deno.env.get("HOME") || "")
          const commandParts = expandedCommand.split(" ")
          await runAppCommand(commandParts)
        }
      }

      // 2. Apply repository (for Linux package managers only)
      const repoUrl = app.repoUrl || app.repo // Support both new and legacy field names
      if (repoUrl && ["zypper", "dnf", "apt"].includes(pkgManager)) {
        console.log(`📦 Adding repository for ${app.name}: ${repoUrl}`)
        const repoName = app.name.toLowerCase().replace(/\s/g, "")

        if (pkgManager === "zypper") {
          // Check if repository already exists
          const checkResult = await runCommand(["zypper", "lr", "--name"])

          if (checkResult.success && checkResult.stdout.includes(repoName)) {
            console.log(`✅ Repository '${repoName}' already exists, skipping...`)
          } else {
            await runAppCommand(["sudo", "zypper", "addrepo", "--refresh", repoUrl, repoName])
          }
          await runAppCommand(["sudo", "zypper", "refresh"])
        } else if (pkgManager === "dnf") {
          // Proper DNF repository addition with GPG key support
          if (app.repoGpgKey) {
            console.log(`🔑 Importing GPG key for ${app.name}: ${app.repoGpgKey}`)
            await runAppCommand(["sudo", "rpm", "--import", app.repoGpgKey])
          }

          // Check if repository already exists and is enabled
          const checkRepo = await runCommand(["dnf", "repolist", "--enabled"])

          if (checkRepo.success && checkRepo.stdout.includes("code")) {
            console.log(`✅ Repository 'code' already exists and is enabled, skipping...`)
          } else {
            // Create VS Code repository file manually (more reliable than remote file)
            console.log(`📦 Creating VS Code repository configuration...`)
            const repoContent = `[code]
name=Visual Studio Code
baseurl=https://packages.microsoft.com/yumrepos/vscode
enabled=1
gpgcheck=1
gpgkey=https://packages.microsoft.com/keys/microsoft.asc`

            const repoFile = "/etc/yum.repos.d/vscode.repo"
            const writeCommand = `echo '${repoContent}' | sudo tee ${repoFile} > /dev/null`
            await runAppCommand(["bash", "-c", writeCommand])
            console.log(`✅ Repository file created: ${repoFile}`)
          }
        } else if (pkgManager === "apt") {
          if (app.repoGpgKey) {
            console.log(`🔑 Adding GPG key for ${app.name}: ${app.repoGpgKey}`)
            await runAppCommand([
              "wget",
              "-qO-",
              app.repoGpgKey,
              "|",
              "sudo",
              "apt-key",
              "add",
              "-",
            ])
          }
          await runAppCommand(["sudo", "add-apt-repository", repoUrl])
          await runAppCommand(["sudo", "apt", "update"])
        }
      }

      // 3. Install packages using OS package manager
      let pkgs: string[] | undefined
      if (pkgManager === "zypper" && app.zypper) pkgs = app.zypper
      else if (pkgManager === "dnf" && app.dnf) pkgs = app.dnf
      else if (pkgManager === "apt" && app.apt) pkgs = app.apt
      else if (pkgManager === "winget" && app.winget) pkgs = app.winget
      else if (pkgManager === "homebrew" && app.homebrew) pkgs = app.homebrew

      if (pkgs && pkgs.length > 0) {
        console.log(`📥 Installing packages for ${app.name}: ${pkgs.join(", ")}`)
        try {
          const result = await installPackages(pkgManager!, pkgs)
          if (!result.success) {
            nativePackagesFailed = true
            nativePackagesError = `Package installation failed: ${result.stderr}`
            console.log(`❌ Native package installation failed: ${result.stderr}`)

            // Don't throw immediately if we have Flatpak as fallback
            if (!app.flatpak || Deno.build.os !== "linux") {
              throw new Error(nativePackagesError)
            } else {
              console.log(`🔄 Will try Flatpak installation as fallback...`)
            }
          } else {
            // Provide clear installation status
            if (result.alreadyInstalled && result.alreadyInstalled.length > 0) {
              console.log(`✅ Already installed: ${result.alreadyInstalled.join(", ")}`)
            }
            if (result.newlyInstalled && result.newlyInstalled.length > 0) {
              console.log(`✅ Newly installed: ${result.newlyInstalled.join(", ")}`)
            }
          }
        } catch (err) {
          nativePackagesFailed = true
          nativePackagesError = err instanceof Error ? err.message : String(err)
          console.log(`❌ Native package installation failed: ${nativePackagesError}`)

          // Don't throw immediately if we have Flatpak as fallback
          if (!app.flatpak || Deno.build.os !== "linux") {
            throw err
          } else {
            console.log(`🔄 Will try Flatpak installation as fallback...`)
          }
        }
      }

      // 4. Install Flatpak (Linux only) - only if native packages failed or no native packages were specified
      if (
        app.flatpak && Deno.build.os === "linux" &&
        (nativePackagesFailed || !pkgs || pkgs.length === 0)
      ) {
        console.log(`📦 Installing Flatpak for ${app.name}: ${app.flatpak}`)
        const flatpakCommand = ["flatpak", "install", "--user", "-y", "flathub", app.flatpak]

        // Check if already installed
        const checkInstalled = await runCommand([
          "flatpak",
          "list",
          "--user",
          `--app=${app.flatpak}`,
        ])
        if (checkInstalled.success && checkInstalled.stdout.includes(app.flatpak)) {
          console.log(`✅ Already installed via Flatpak: ${app.flatpak}`)
        } else {
          // First attempt
          let result = await runCommand(flatpakCommand)
          if (!result.success && result.stderr.includes("Nothing matches")) {
            console.log(`🔄 App not found, syncing remote and retrying...`)
            // Try to sync the remote and retry
            await runCommand(["flatpak", "update", "--user", "--appstream"])
            result = await runCommand(flatpakCommand)
          }

          if (!result.success) {
            if (nativePackagesFailed) {
              // Both native and Flatpak failed
              throw new Error(
                `Both native package and Flatpak installation failed. Native: ${nativePackagesError}. Flatpak: ${result.stderr}`,
              )
            } else {
              // Only Flatpak failed, but native might have succeeded
              const errorMsg = `Flatpak installation failed: ${result.stderr}`
              console.error(`❌ ${errorMsg}`)
              throw new Error(errorMsg)
            }
          } else {
            console.log(`✅ Successfully installed via Flatpak: ${app.flatpak}`)
            if (result.stdout) console.log(`Stdout: ${result.stdout}`)
          }
        }
      } else if (
        app.flatpak && Deno.build.os === "linux" && !nativePackagesFailed && pkgs && pkgs.length > 0
      ) {
        console.log(
          `ℹ️  Skipping Flatpak installation for ${app.name} - native packages were successfully installed`,
        )
      } else if (nativePackagesFailed) {
        // Native packages failed and no Flatpak available
        throw new Error(nativePackagesError)
      }

      // 5. Execute post-installation commands
      if (app.postInstallCommands && app.postInstallCommands.length > 0) {
        console.log(`🔧 Running post-installation commands for ${app.name}:`)
        for (const command of app.postInstallCommands) {
          let expandedCommand = command
          expandedCommand = expandedCommand.replace(/\$USER/g, Deno.env.get("USER") || "")
          expandedCommand = expandedCommand.replace(/\$HOME/g, Deno.env.get("HOME") || "")
          const commandParts = expandedCommand.split(" ")
          await runAppCommand(commandParts)
        }
      }

      if (app.requiresReboot) {
        needsReboot = true
      }
    } catch (err) {
      appFailed = true
      errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`❌ Failed to install ${app.name}: ${errorMsg}`)
    }

    if (appFailed) {
      failedApps.push({ name: app.name, error: errorMsg })
    } else {
      successApps.push(app.name)
    }
  }

  console.log("\n🏁 All applications processed.\n")
  console.log("📊 Installation summary:")
  console.log("---------------------")
  console.log(
    `✅ Successfully installed: ${successApps.length > 0 ? successApps.join(", ") : "None"}`,
  )
  if (skippedApps.length > 0) {
    console.log(`⚠️  Skipped (architecture incompatible): ${skippedApps.join(", ")}`)
  }
  if (failedApps.length > 0) {
    console.log("❌ Failed to install:")
    for (const fail of failedApps) {
      console.log(`- ${fail.name}: ${fail.error}`)
    }
  } else {
    console.log("✅ No installation failures.")
  }

  if (needsReboot) {
    if (confirm("🔄 Some installations require a system reboot.\nWould you like to reboot now?")) {
      console.log("🔄 Rebooting now...")
      await runAppCommand(["sudo", "reboot"])
    } else {
      console.log("⚠️  Please reboot your system when convenient.")
    }
  } else {
    console.log("✅ No reboot required.")
  }

  console.log("🎉 Installation complete!")
}

main()
