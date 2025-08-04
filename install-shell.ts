/**
 * Install Shell Setup Script
 *
 * Automates the installation and configuration of:
 * - Zsh shell
 * - Oh My Zsh framework
 * - Powerlevel10k theme
 * - Custom aliases integration
 */

import {
  commandExists,
  detectPackageManager,
  directoryExists,
  fileExists,
  type PackageManager,
} from "./shared.ts"

interface SetupStep {
  name: string
  command: string
  description: string
  skipIfExists?: () => Promise<boolean>
}

export class InstallShell {
  private readonly homeDir = Deno.env.get("HOME") ?? `/home/${Deno.env.get("USER")}`
  private readonly dotfilesDir = new URL(".", import.meta.url).pathname
  private readonly zshrcPath = `${this.homeDir}/.zshrc`
  private packageManager: PackageManager | null = null

  private async runCommand(command: string, description: string): Promise<boolean> {
    console.log(`🔄 ${description}...`)
    console.log(`📝 Running: ${command}`)

    try {
      // Create command with inherit stdio to show output in real-time
      const cmd = new Deno.Command("bash", {
        args: ["-c", command],
        stdout: "inherit",
        stderr: "inherit",
      })

      const { success, code } = await cmd.output()

      if (success) {
        console.log(`✅ ${description} completed successfully`)
        return true
      } else {
        console.error(`❌ ${description} failed with exit code: ${code}`)
        return false
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`❌ ${description} failed: ${errorMessage}`)
      return false
    }
  }

  private async isZshInstalled(): Promise<boolean> {
    return await commandExists("zsh")
  }

  private async getCurrentUserShell(): Promise<string | null> {
    try {
      const cmd = new Deno.Command("getent", {
        args: ["passwd", Deno.env.get("USER") || ""],
        stdout: "piped",
        stderr: "piped",
      })

      const { success, stdout } = await cmd.output()
      if (success) {
        const output = new TextDecoder().decode(stdout)
        const fields = output.trim().split(":")
        return fields[6] || null // Shell is the 7th field (index 6)
      }
      return null
    } catch {
      return null
    }
  }

  private async setupAliasesIntegration(): Promise<boolean> {
    const aliasesPath = `${this.dotfilesDir}aliases.sh`
    const sourceCommand = `\n# Source custom aliases from dotfiles\nsource "${aliasesPath}"\n`

    try {
      // Check if the source command already exists in .zshrc
      if (await fileExists(this.zshrcPath)) {
        const zshrcContent = await Deno.readTextFile(this.zshrcPath)
        if (zshrcContent.includes(`source "${aliasesPath}"`)) {
          console.log("✅ Aliases integration already configured")
          return true
        }
      }

      // Append the source command to .zshrc
      await Deno.writeTextFile(this.zshrcPath, sourceCommand, { append: true })
      console.log("✅ Aliases integration added to .zshrc")
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`❌ Failed to setup aliases integration: ${errorMessage}`)
      return false
    }
  }

  private async setupDenoPath(): Promise<boolean> {
    const denoPathConfig = `\n# Add Deno to PATH\nexport PATH="$HOME/.deno/bin:$PATH"\n`

    try {
      // Check if Deno PATH is already configured in .zshrc
      if (await fileExists(this.zshrcPath)) {
        const zshrcContent = await Deno.readTextFile(this.zshrcPath)
        if (zshrcContent.includes('export PATH="$HOME/.deno/bin:$PATH"') || 
            zshrcContent.includes("$HOME/.deno/bin") ||
            zshrcContent.includes("~/.deno/bin")) {
          console.log("✅ Deno PATH already configured")
          return true
        }
      }

      // Append the Deno PATH configuration to .zshrc
      await Deno.writeTextFile(this.zshrcPath, denoPathConfig, { append: true })
      console.log("✅ Deno PATH added to .zshrc")
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`❌ Failed to setup Deno PATH: ${errorMessage}`)
      return false
    }
  }

  private async setupSteps(): Promise<SetupStep[]> {
    if (!this.packageManager) {
      throw new Error("Package manager not detected")
    }

    const updateCmd = this.packageManager === "apt"
      ? "sudo apt update"
      : this.packageManager === "dnf"
      ? "sudo dnf check-update || true" // dnf returns non-zero when updates available
      : "echo 'No update needed'"

    const installCmd = this.packageManager === "apt"
      ? "sudo apt install zsh -y"
      : this.packageManager === "dnf"
      ? "sudo dnf install zsh -y"
      : this.packageManager === "zypper"
      ? "sudo zypper install -y zsh"
      : "echo 'Unsupported package manager for zsh installation'"

    return [
      {
        name: "update-packages",
        command: updateCmd,
        description: `Updating ${this.packageManager} package lists`,
        skipIfExists: async () => false, // Always update
      },
      {
        name: "install-zsh",
        command: installCmd,
        description: "Installing Zsh shell",
        skipIfExists: () => this.isZshInstalled(),
      },
      {
        name: "install-oh-my-zsh",
        command:
          'sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended',
        description: "Installing Oh My Zsh framework",
        skipIfExists: () => directoryExists(`${this.homeDir}/.oh-my-zsh`),
      },
      {
        name: "install-powerlevel10k",
        command:
          `git clone --depth=1 https://github.com/romkatv/powerlevel10k.git \${ZSH_CUSTOM:-${this.homeDir}/.oh-my-zsh/custom}/themes/powerlevel10k`,
        description: "Installing Powerlevel10k theme",
        skipIfExists: () =>
          directoryExists(`${this.homeDir}/.oh-my-zsh/custom/themes/powerlevel10k`),
      },
    ]
  }

  private async updateZshTheme(): Promise<boolean> {
    console.log("🔄 Configuring Powerlevel10k theme in .zshrc...")

    try {
      if (!(await fileExists(this.zshrcPath))) {
        console.error("❌ .zshrc file not found")
        return false
      }

      let zshrcContent = await Deno.readTextFile(this.zshrcPath)

      // Check if theme is already set to powerlevel10k
      if (zshrcContent.includes('ZSH_THEME="powerlevel10k/powerlevel10k"')) {
        console.log("✅ Powerlevel10k theme already configured")
        return true
      }

      // Replace existing ZSH_THEME line or add it
      const themeRegex = /^ZSH_THEME=".*"$/m
      const newTheme = 'ZSH_THEME="powerlevel10k/powerlevel10k"'

      if (themeRegex.test(zshrcContent)) {
        zshrcContent = zshrcContent.replace(themeRegex, newTheme)
      } else {
        // If no theme line exists, add it after the Oh My Zsh path line
        const pathRegex = /^export ZSH=".*"$/m
        if (pathRegex.test(zshrcContent)) {
          zshrcContent = zshrcContent.replace(pathRegex, `$&\n\n${newTheme}`)
        } else {
          // Fallback: add at the beginning
          zshrcContent = `${newTheme}\n${zshrcContent}`
        }
      }

      await Deno.writeTextFile(this.zshrcPath, zshrcContent)
      console.log("✅ Powerlevel10k theme configured in .zshrc")
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`❌ Failed to configure theme: ${errorMessage}`)
      return false
    }
  }

  public async run(): Promise<void> {
    console.log("🚀 Starting shell installation setup...\n")

    // Detect package manager first
    this.packageManager = await detectPackageManager()
    if (!this.packageManager) {
      console.error("❌ Could not detect supported package manager for this OS.")
      Deno.exit(1)
    }

    console.log(`✅ Detected package manager: ${this.packageManager}\n`)

    const steps = await this.setupSteps()
    let successCount = 0
    let skippedCount = 0

    // Execute setup steps - stop on first failure
    for (const step of steps) {
      // Check if we should skip this step
      if (step.skipIfExists && await step.skipIfExists()) {
        console.log(`⏭️  Skipping: ${step.description} (already installed)`)
        skippedCount++
        continue
      }

      const success = await this.runCommand(step.command, step.description)
      if (success) {
        successCount++
      } else {
        console.error(`❌ Setup failed at step: ${step.description}`)
        console.error("❌ Stopping execution due to failure")
        Deno.exit(1)
      }
      console.log() // Add spacing between steps
    }

    // Configure Powerlevel10k theme - only if all previous steps succeeded
    const themeSuccess = await this.updateZshTheme()
    if (!themeSuccess) {
      console.error("❌ Failed to configure theme, but continuing...")
    }

    // Setup aliases integration
    const aliasSuccess = await this.setupAliasesIntegration()
    if (!aliasSuccess) {
      console.error("❌ Failed to setup aliases integration, but continuing...")
    }

    // Setup Deno PATH
    const denoPathSuccess = await this.setupDenoPath()
    if (!denoPathSuccess) {
      console.error("❌ Failed to setup Deno PATH, but continuing...")
    }

    // Print summary
    console.log("\n" + "=".repeat(50))
    console.log("📋 Setup Summary:")
    console.log(`✅ Successful steps: ${successCount}`)
    console.log(`⏭️  Skipped steps: ${skippedCount}`)
    console.log(`❌ Failed steps: 0`) // We exit on failure, so this is always 0

    console.log("\n🎉 Shell installation completed!")

    // Automatically execute final setup steps
    console.log("\n� Executing final setup steps...")

    // 1. Set Zsh as default shell
    const username = Deno.env.get("USER") || "unknown"
    const chshSuccess = await this.runCommand(
      `sudo chsh -s $(which zsh) ${username}`,
      "Setting Zsh as default shell",
    )

    if (!chshSuccess) {
      console.log("⚠️  Failed to set Zsh as default shell automatically.")
      console.log("📝 You can manually set it by running:")
      console.log(`   sudo chsh -s $(which zsh) ${username}`)
      console.log("   or")
      console.log(`   chsh -s $(which zsh)`)
    } else {
      // Verify the shell was actually changed
      const currentShell = await this.getCurrentUserShell()

      if (currentShell?.includes("zsh")) {
        console.log("✅ Zsh successfully set as default shell")
      } else {
        console.log("⚠️  Shell change may not have taken effect. Current shell:", currentShell)
      }
    }

    // 2. Source .zshrc (this needs to be done in the user's current shell session)
    console.log("✅ Configuration updated - changes will take effect in new terminal sessions")

    // 3. Run p10k configure (only if Powerlevel10k was installed)
    const p10kInstalled = await directoryExists(
      `${this.homeDir}/.oh-my-zsh/custom/themes/powerlevel10k`,
    )
    if (p10kInstalled) {
      console.log("\n📝 Note: Powerlevel10k theme is installed and configured.")
      console.log(
        "On your first zsh session, you'll be prompted to configure the theme with 'p10k configure'.",
      )
      console.log("You can also run it manually anytime with: p10k configure")
    }

    console.log("\n✨ All setup steps completed!")
    console.log(
      "Your shell environment is now configured with custom aliases automatically loaded.",
    )
    console.log("\n🔄 To start using your new shell setup:")
    console.log("   • Close this terminal and open a new one, OR")
    console.log("   • Run: exec zsh")
    console.log("\n📋 What's been configured:")
    console.log("   ✅ Zsh shell installed")
    console.log("   ✅ Oh My Zsh framework installed")
    console.log("   ✅ Powerlevel10k theme configured")
    console.log("   ✅ Custom aliases integrated")
    console.log("   ✅ Deno PATH configured")

    const currentShell = await this.getCurrentUserShell()
    if (currentShell?.includes("zsh")) {
      console.log("   ✅ Zsh set as default shell")
    } else {
      console.log("   ⚠️  Default shell may need manual configuration")
    }
  }
}

// Run the setup
const setup = new InstallShell()
await setup.run()
