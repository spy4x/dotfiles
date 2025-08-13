#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write --allow-env

/**
 * Hibernation Setup Script for Fedora 42 KDE with Btrfs
 *
 * Based on: https://fedoramagazine.org/update-on-hibernation-in-fedora-workstation/
 *
 * This script automates the hibernation setup process with safety checks,
 * configurable parameters, and full idempotency. It uses the modern UEFI-based
 * method for automatic resume detection.
 *
 * Features:
 * - ✅ Comprehensive pre-flight checks
 * - ✅ Configurable parameters
 * - ✅ Full idempotency (can be re-run safely)
 * - ✅ Detailed logging with emojis
 * - ✅ System state validation
 * - ✅ KDE integration
 */

import {
  directoryExists,
  fileExists,
  formatBytes,
  getDiskUsage,
  getSystemMemoryBytes,
  initializeLogging,
  log,
  runCommand,
  runShellCommand,
} from "./shared.ts"

// ===== CONFIGURATION =====
const CONFIG = {
  // Remove ZRAM to prevent conflicts with hibernation swap
  removeZram: true,

  // Resize Btrfs filesystem to maximum size before creating swap
  resizeBtrfsToMax: true,

  // Swap size multiplier (default: 1.5x RAM size)
  swapSizeMultiplier: 1.5,

  // Maximum swap size as percentage of total disk space (safety limit)
  maxSwapPercentageOfDisk: 20,

  // Paths
  swapSubvolume: "/var/swap",
  swapFile: "/var/swap/swapfile",

  // Minimum free disk space required (in GB) after swap creation
  minFreeDiskSpaceGB: 10,
} as const

// ===== SYSTEM STATE CHECKING FUNCTIONS =====

/**
 * Check if the system is running KDE
 */
async function isKDE(): Promise<boolean> {
  // Check for KDE environment variables
  const kdeSession = Deno.env.get("KDE_SESSION_VERSION")
  const desktopSession = Deno.env.get("DESKTOP_SESSION")
  const xdgCurrentDesktop = Deno.env.get("XDG_CURRENT_DESKTOP")

  if (kdeSession || desktopSession?.includes("kde") || xdgCurrentDesktop?.includes("KDE")) {
    return true
  }

  // Check if plasma-powerdevil process is running
  const result = await runShellCommand("pgrep -f plasma-powerdevil")
  return result.success
}

/**
 * Check if ZRAM is enabled
 */
async function isZramEnabled(): Promise<boolean> {
  const result = await runShellCommand("swapon --show=NAME --noheadings | grep -q zram")
  return result.success
}

/**
 * Check if system uses UEFI boot
 */
async function isUEFIBoot(): Promise<boolean> {
  // First try bootctl (most reliable but needs permissions)
  const bootctl = await runShellCommand("bootctl status 2>/dev/null")
  if (bootctl.success) {
    return true
  }

  // Fallback 1: Check for EFI system partition
  const efiMount = await runShellCommand("mount | grep -i efi")
  if (efiMount.success && efiMount.stdout.includes("/boot/efi")) {
    return true
  }

  // Fallback 2: Check if /sys/firmware/efi exists (UEFI systems have this)
  const efiSys = await runShellCommand("test -d /sys/firmware/efi")
  if (efiSys.success) {
    return true
  }

  // Fallback 3: Check EFI variables directory
  const efiVars = await runShellCommand("test -d /sys/firmware/efi/efivars")
  if (efiVars.success) {
    return true
  }

  return false
}

/**
 * Check if filesystem is Btrfs
 */
async function isBtrfs(path: string): Promise<boolean> {
  const result = await runShellCommand(`df -T "${path}" | tail -1 | awk '{print $2}'`)
  if (!result.success) return false

  return result.stdout.trim() === "btrfs"
}

/**
 * Check if swap file already exists
 */
async function swapFileExists(): Promise<boolean> {
  return await fileExists(CONFIG.swapFile)
}

/**
 * Get current swap usage
 */
async function getCurrentSwap(): Promise<{ device: string; size: string; used: string }[]> {
  const result = await runShellCommand("swapon --show --noheadings")
  if (!result.success) return []

  return result.stdout.trim().split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const parts = line.trim().split(/\s+/)
      return {
        device: parts[0] || "",
        size: parts[2] || "",
        used: parts[3] || "",
      }
    })
}

/**
 * Check if swap subvolume exists and has correct attributes
 */
async function isSwapSubvolumeConfigured(): Promise<boolean> {
  if (!(await directoryExists(CONFIG.swapSubvolume))) {
    return false
  }

  // Check if it's a Btrfs subvolume
  const subvolCheck = await runShellCommand(
    `btrfs subvolume show ${CONFIG.swapSubvolume} 2>/dev/null`,
  )
  if (!subvolCheck.success) {
    return false
  }

  // Check if CoW is disabled (has +C attribute)
  const attrCheck = await runShellCommand(`lsattr -d ${CONFIG.swapSubvolume} | grep -q '^[^-]*C'`)
  return attrCheck.success
}

/**
 * Check if swap is configured in /etc/fstab
 */
async function isSwapInFstab(): Promise<boolean> {
  const result = await runShellCommand(`grep -q "${CONFIG.swapFile}" /etc/fstab`)
  return result.success
}

/**
 * Check if dracut resume module is configured
 */
async function isDracutResumeConfigured(): Promise<boolean> {
  const dracutConf = "/etc/dracut.conf.d/resume.conf"
  if (!(await fileExists(dracutConf))) {
    return false
  }

  const content = await runShellCommand(`cat ${dracutConf}`)
  return content.success && content.stdout.includes('add_dracutmodules+=" resume "')
}

/**
 * Check if SELinux contexts are properly configured for swap
 */
async function isSwapSELinuxConfigured(): Promise<boolean> {
  const result = await runShellCommand(
    `semanage fcontext -l | grep -q "${CONFIG.swapFile}.*swapfile_t"`,
  )
  return result.success
}

/**
 * Check if PolicyKit hibernation rule exists
 */
async function isPolicyKitHibernationConfigured(): Promise<boolean> {
  const polkitFile = "/etc/polkit-1/localauthority/50-local.d/hibernate.pkla"
  if (!(await fileExists(polkitFile))) {
    return false
  }

  const content = await runShellCommand(`cat ${polkitFile}`)
  return content.success &&
    content.stdout.includes("org.freedesktop.login1.hibernate") &&
    content.stdout.includes("ResultActive=yes")
}

/**
 * Check if hibernation is fully functional
 */
async function _isHibernationFullyConfigured(): Promise<boolean> {
  // Check kernel support
  const kernelSupport = await runShellCommand("cat /sys/power/state")
  if (!kernelSupport.success || !kernelSupport.stdout.includes("disk")) {
    return false
  }

  // Check if our swap file is active
  const currentSwap = await getCurrentSwap()
  const ourSwap = currentSwap.find((swap) => swap.device === CONFIG.swapFile)
  if (!ourSwap) {
    return false
  }

  // Check system configuration
  const checks = await Promise.all([
    isSwapSubvolumeConfigured(),
    isSwapInFstab(),
    isDracutResumeConfigured(),
    isSwapSELinuxConfigured(),
    isPolicyKitHibernationConfigured(),
  ])

  return checks.every((check) => check)
}

// ===== PRE-FLIGHT CHECKS =====

async function performPreFlightChecks(): Promise<{ ramBytes: number; swapSizeBytes: number }> {
  await log("🔍 Starting pre-flight checks...")

  // Check if running as root (shouldn't be)
  try {
    const uid = await runShellCommand("id -u")
    if (uid.success && uid.stdout.trim() === "0") {
      throw new Error(
        "This script should not be run as root. Run as regular user - sudo will be used when needed.",
      )
    }
  } catch (_error) {
    await log("Could not determine user ID, continuing anyway", "WARN")
  }
  await log("Running as non-root user")

  // Check OS and distribution
  if (Deno.build.os !== "linux") {
    throw new Error("This script is designed for Linux systems only")
  }

  const osRelease = await runShellCommand("cat /etc/os-release")
  if (!osRelease.success || !osRelease.stdout.includes("Fedora")) {
    await log("This script is designed for Fedora, but will continue anyway", "WARN")
  } else {
    await log("Running on Fedora Linux")
  }

  // Check for UEFI boot (required for automatic resume)
  if (!(await isUEFIBoot())) {
    throw new Error(
      "UEFI boot is required for automatic hibernation resume. Legacy BIOS is not supported.",
    )
  }
  await log("UEFI boot system detected")

  // Check filesystem type
  if (!(await isBtrfs("/"))) {
    throw new Error("Root filesystem must be Btrfs for this hibernation setup method")
  }
  await log("Btrfs filesystem detected")

  // Check required commands exist
  const requiredCommands = [
    "btrfs",
    "swapon",
    "swapoff",
    "dracut",
    "semanage",
    "restorecon",
    "chattr",
  ]
  for (const cmd of requiredCommands) {
    const result = await runCommand(["which", cmd])
    if (!result.success) {
      throw new Error(`Required command '${cmd}' not found. Please install the necessary packages.`)
    }
  }
  await log("All required commands available")

  // Get system memory
  const ramBytes = await getSystemMemoryBytes()
  await log(`System RAM: ${formatBytes(ramBytes)}`)

  // Calculate swap size
  const swapSizeBytes = Math.round(ramBytes * CONFIG.swapSizeMultiplier)
  await log(
    `Calculated swap size: ${formatBytes(swapSizeBytes)} (${CONFIG.swapSizeMultiplier}x RAM)`,
  )

  // Check disk space
  const diskUsage = await getDiskUsage("/")
  const swapPercentage = (swapSizeBytes / diskUsage.total) * 100

  await log(`Disk total: ${formatBytes(diskUsage.total)}`)
  await log(`Disk available: ${formatBytes(diskUsage.available)}`)
  await log(`Swap would use ${swapPercentage.toFixed(1)}% of total disk space`)

  if (swapPercentage > CONFIG.maxSwapPercentageOfDisk) {
    throw new Error(
      `Swap size (${formatBytes(swapSizeBytes)}) would exceed ${CONFIG.maxSwapPercentageOfDisk}% ` +
        `of total disk space. Maximum allowed: ${
          formatBytes(diskUsage.total * CONFIG.maxSwapPercentageOfDisk / 100)
        }`,
    )
  }

  if (swapSizeBytes > diskUsage.available - (CONFIG.minFreeDiskSpaceGB * 1024 ** 3)) {
    throw new Error(
      `Insufficient disk space. Need ${
        formatBytes(swapSizeBytes + CONFIG.minFreeDiskSpaceGB * 1024 ** 3)
      } ` +
        `but only ${formatBytes(diskUsage.available)} available`,
    )
  }

  // Check hibernation support in kernel
  const hibernationSupport = await runShellCommand("cat /sys/power/state")
  if (!hibernationSupport.success || !hibernationSupport.stdout.includes("disk")) {
    throw new Error("Kernel does not support hibernation (no 'disk' in /sys/power/state)")
  }
  await log("Kernel hibernation support detected")

  // Check current hibernation configuration status
  const fullyConfigured = await _isHibernationFullyConfigured()
  if (fullyConfigured) {
    await log("🎉 Hibernation appears to be fully configured already!", "SUCCESS")
    await log("Re-running to verify and fix any issues...")
  }

  await log("All pre-flight checks passed!", "SUCCESS")
  return { ramBytes, swapSizeBytes }
}

// ===== IMPLEMENTATION FUNCTIONS =====

/**
 * Remove ZRAM if it exists and is enabled
 */
async function removeZramIfEnabled(): Promise<void> {
  if (!CONFIG.removeZram) {
    await log("🔄 ZRAM removal disabled in configuration, skipping...")
    return
  }

  await log("🔍 Checking for ZRAM...")

  if (!(await isZramEnabled())) {
    await log("ZRAM not active")
    return
  }

  await log("🗑️ ZRAM detected, removing to prevent conflicts with hibernation...")

  // Disable ZRAM
  const _result = await runShellCommand("sudo swapoff /dev/zram* 2>/dev/null || true")

  // Remove ZRAM service if it exists
  const zramService = await runShellCommand(
    "systemctl is-enabled zram-generator@zram0.service 2>/dev/null",
  )
  if (zramService.success) {
    await log("🔧 Disabling ZRAM service...")
    const disableResult = await runShellCommand(
      "sudo systemctl disable zram-generator@zram0.service",
    )
    if (!disableResult.success) {
      await log(`Could not disable ZRAM service: ${disableResult.stderr}`, "WARN")
    }
  }

  await log("ZRAM removed successfully", "SUCCESS")
}

/**
 * Restore Btrfs filesystem to maximum size
 */
async function restoreBtrfsFilesystem(): Promise<void> {
  if (!CONFIG.resizeBtrfsToMax) {
    await log("🔄 Btrfs resize disabled in configuration, skipping...")
    return
  }

  await log("📏 Ensuring Btrfs filesystem is at maximum size...")

  const result = await runShellCommand("sudo btrfs filesystem resize max /")
  if (!result.success) {
    throw new Error(`Failed to resize Btrfs filesystem: ${result.stderr}`)
  }

  await log("Btrfs filesystem resized to maximum", "SUCCESS")
}

/**
 * Create hibernation swap file
 */
async function createHibernationSwap(swapSizeBytes: number): Promise<void> {
  const swapSizeGB = Math.ceil(swapSizeBytes / (1024 ** 3))
  await log(`💾 Creating hibernation swap (${swapSizeGB}G)...`)

  // Create Btrfs subvolume if it doesn't exist
  if (!(await directoryExists(CONFIG.swapSubvolume))) {
    await log("📁 Creating Btrfs subvolume for swap...")
    const subvolResult = await runShellCommand(
      `sudo btrfs subvolume create ${CONFIG.swapSubvolume}`,
    )
    if (!subvolResult.success) {
      throw new Error(`Failed to create Btrfs subvolume: ${subvolResult.stderr}`)
    }
    await log("Btrfs subvolume created")
  } else {
    await log("Btrfs subvolume already exists")
  }

  // Check and set Copy-on-Write (CoW) attribute
  const cowCheck = await runShellCommand(`lsattr -d ${CONFIG.swapSubvolume} | grep -q '^[^-]*C'`)
  if (!cowCheck.success) {
    await log("🔧 Disabling Copy-on-Write for swap directory...")
    const chattr = await runShellCommand(`sudo chattr +C ${CONFIG.swapSubvolume}`)
    if (!chattr.success) {
      throw new Error(`Failed to disable CoW: ${chattr.stderr}`)
    }
    await log("Copy-on-Write disabled")
  } else {
    await log("Copy-on-Write already disabled")
  }

  // Set SELinux context for the swap directory
  await log("🔒 Setting SELinux context...")
  const restorecon = await runShellCommand(`sudo restorecon ${CONFIG.swapSubvolume}`)
  if (!restorecon.success) {
    await log(`Could not restore SELinux context: ${restorecon.stderr}`, "WARN")
  } else {
    await log("SELinux context set")
  }

  // Create the swap file if it doesn't exist
  if (!(await swapFileExists())) {
    await log(`📄 Creating ${swapSizeGB}G swap file...`)
    const mkswap = await runShellCommand(
      `sudo btrfs filesystem mkswapfile --size ${swapSizeGB}G --uuid clear ${CONFIG.swapFile}`,
    )
    if (!mkswap.success) {
      throw new Error(`Failed to create swap file: ${mkswap.stderr}`)
    }
    await log("Swap file created")
  } else {
    // Verify existing swap file size
    const stat = await runShellCommand(`stat -c %s ${CONFIG.swapFile}`)
    if (stat.success) {
      const existingSize = parseInt(stat.stdout.trim())
      await log(`Swap file already exists (${formatBytes(existingSize)})`)

      // Warn if size difference is significant
      const sizeDiff = Math.abs(existingSize - swapSizeBytes)
      if (sizeDiff > swapSizeBytes * 0.1) { // More than 10% difference
        await log(`Existing swap size differs significantly from calculated size`, "WARN")
      }
    } else {
      await log("Swap file already exists")
    }
  }

  await log("Hibernation swap configured successfully!", "SUCCESS")
}

/**
 * Enable swap permanently by adding to /etc/fstab
 */
async function enableSwapPermanently(): Promise<void> {
  await log("⚙️ Configuring permanent swap activation...")

  // Check if already in fstab
  if (await isSwapInFstab()) {
    await log("Swap already configured in /etc/fstab")
  } else {
    await log("📝 Adding swap to /etc/fstab...")
    const fstabEntry = `${CONFIG.swapFile} none swap defaults 0 0`
    const addToFstab = await runShellCommand(`echo "${fstabEntry}" | sudo tee --append /etc/fstab`)
    if (!addToFstab.success) {
      throw new Error(`Failed to add swap to /etc/fstab: ${addToFstab.stderr}`)
    }
    await log("Swap added to /etc/fstab")
  }

  // Check if swap is already active
  const currentSwap = await getCurrentSwap()
  const ourSwap = currentSwap.find((swap) => swap.device === CONFIG.swapFile)

  if (!ourSwap) {
    await log("🔄 Activating swap...")
    const swapOn = await runShellCommand("sudo swapon --all --verbose")
    if (!swapOn.success) {
      throw new Error(`Failed to activate swap: ${swapOn.stderr}`)
    }

    // Verify swap is now active
    const verifySwap = await getCurrentSwap()
    const newSwap = verifySwap.find((swap) => swap.device === CONFIG.swapFile)
    if (!newSwap) {
      throw new Error("Swap file was not activated successfully")
    }
    await log(`Swap activated successfully: ${newSwap.size}`, "SUCCESS")
  } else {
    await log(`Swap already active: ${ourSwap.size}`)
  }
}

/**
 * Configure hibernation support in the system
 */
async function configureHibernationSupport(): Promise<void> {
  await log("🔧 Configuring hibernation support...")

  // Add dracut resume module
  const dracutConf = "/etc/dracut.conf.d/resume.conf"

  if (!(await isDracutResumeConfigured())) {
    await log("📝 Configuring dracut resume module...")
    const dracutContent = 'add_dracutmodules+=" resume "'
    const createDracut = await runShellCommand(`echo '${dracutContent}' | sudo tee ${dracutConf}`)
    if (!createDracut.success) {
      throw new Error(`Failed to create dracut configuration: ${createDracut.stderr}`)
    }
    await log("Dracut resume module configuration created")

    // Rebuild initramfs
    await log("🔄 Rebuilding initramfs (this may take a moment)...")
    const dracut = await runShellCommand("sudo dracut --force")
    if (!dracut.success) {
      throw new Error(`Failed to rebuild initramfs: ${dracut.stderr}`)
    }
    await log("Initramfs rebuilt")
  } else {
    await log("Dracut resume module already configured")
  }

  // Configure SELinux contexts for the swap file
  if (!(await isSwapSELinuxConfigured())) {
    await log("🔒 Configuring SELinux contexts for swap file...")
    const semanage = await runShellCommand(
      `sudo semanage fcontext --add --type swapfile_t ${CONFIG.swapFile}`,
    )
    if (!semanage.success && !semanage.stderr.includes("already defined")) {
      throw new Error(`Failed to set SELinux context: ${semanage.stderr}`)
    }

    const restorecon = await runShellCommand(`sudo restorecon -RF ${CONFIG.swapSubvolume}`)
    if (!restorecon.success) {
      await log(`Could not restore SELinux contexts: ${restorecon.stderr}`, "WARN")
    } else {
      await log("SELinux contexts configured")
    }
  } else {
    await log("SELinux contexts already configured")
  }

  await log("Hibernation support configured successfully!", "SUCCESS")
}

/**
 * Enable user hibernation permissions via PolicyKit
 */
async function enableUserHibernationPermissions(): Promise<void> {
  await log("👤 Configuring user hibernation permissions...")

  if (await isPolicyKitHibernationConfigured()) {
    await log("PolicyKit hibernation rule already exists")
  } else {
    const polkitDir = "/etc/polkit-1/localauthority/50-local.d"
    const polkitFile = `${polkitDir}/hibernate.pkla`

    // Ensure directory exists
    const mkdirResult = await runShellCommand(`sudo mkdir -p ${polkitDir}`)
    if (!mkdirResult.success) {
      throw new Error(`Failed to create PolicyKit directory: ${mkdirResult.stderr}`)
    }

    // Create PolicyKit rule
    await log("📝 Creating PolicyKit hibernation rule...")
    const polkitContent = `[Allow hibernation]
Identity=unix-user:*
Action=org.freedesktop.login1.hibernate;org.freedesktop.login1.hibernate-multiple-sessions
ResultActive=yes`

    const createPolkit = await runShellCommand(`sudo tee ${polkitFile} << 'EOF'
${polkitContent}
EOF`)
    if (!createPolkit.success) {
      throw new Error(`Failed to create PolicyKit rule: ${createPolkit.stderr}`)
    }
    await log("PolicyKit hibernation rule created")
  }

  // Restart PolicyKit service
  await log("🔄 Restarting PolicyKit service...")
  const restartPolkit = await runShellCommand("sudo systemctl restart polkit")
  if (!restartPolkit.success) {
    throw new Error(`Failed to restart PolicyKit: ${restartPolkit.stderr}`)
  }
  await log("PolicyKit service restarted")

  await log("User hibernation permissions configured!", "SUCCESS")
}

/**
 * Restart power management if running KDE
 */
async function restartPowerManagement(): Promise<void> {
  if (!(await isKDE())) {
    await log("Not running KDE, skipping power management restart")
    return
  }

  await log("🔋 KDE detected, restarting power management...")

  const restart = await runShellCommand("systemctl --user restart plasma-powerdevil")
  if (!restart.success) {
    await log(`Could not restart plasma-powerdevil: ${restart.stderr}`, "WARN")
    await log("You may need to restart plasma-powerdevil manually or log out/in", "WARN")
  } else {
    await log("KDE power management restarted", "SUCCESS")
  }
}

/**
 * Perform verification tests
 */
async function performVerificationTests(): Promise<void> {
  await log("🧪 Performing verification tests...")

  // Check swap is active
  await log("🔍 Verifying swap activation...")
  const swapInfo = await getCurrentSwap()
  const ourSwap = swapInfo.find((swap) => swap.device === CONFIG.swapFile)
  if (!ourSwap) {
    throw new Error("Swap file is not active")
  }
  await log(`Swap active: ${CONFIG.swapFile} (${ourSwap.size})`)

  // Check hibernation support
  await log("🔍 Verifying hibernation support...")
  const hibernationState = await runShellCommand("cat /sys/power/state")
  if (!hibernationState.success || !hibernationState.stdout.includes("disk")) {
    throw new Error("Hibernation not supported by kernel")
  }
  await log("Hibernation support available")

  // Test hibernation dry run
  await log("🧪 Testing hibernation dry run...")
  const dryRun = await runShellCommand("systemctl hibernate --dry-run")
  if (!dryRun.success) {
    await log(`Hibernation dry run failed: ${dryRun.stderr}`, "WARN")
    await log("This might be normal if hibernation dependencies are not fully loaded", "WARN")
  } else {
    await log("Hibernation dry run successful")
  }

  await log("Verification tests completed!", "SUCCESS")
}

// ===== MAIN EXECUTION =====

async function main(): Promise<void> {
  console.log("🔧 Fedora Hibernation Configuration Script")
  console.log("==========================================")

  let logPath: string

  try {
    // Initialize logging
    logPath = await initializeLogging("configure-hibernate-on-fedora-btrfs")
    await log("🚀 Hibernation configuration script started")
    await log(`📋 Log file: ${logPath}`)

    // Check if already fully configured
    const alreadyConfigured = await _isHibernationFullyConfigured()
    if (alreadyConfigured) {
      await log("🎉 Hibernation appears to be fully configured already!")
      await log("Running verification tests to ensure everything is working...")
      await performVerificationTests()
      console.log("\n✅ Hibernation is already configured and working!")
      console.log("\n📝 Quick test:")
      console.log("   • Test hibernation: systemctl hibernate")
      console.log("   • The hibernation option should be available in KDE power menu immediately")
      console.log("   • UEFI will automatically resume from hibernation")
      return
    }

    // Pre-flight checks
    const { ramBytes, swapSizeBytes } = await performPreFlightChecks()

    console.log("\n📋 Configuration Summary:")
    console.log(`   🧠 RAM: ${formatBytes(ramBytes)}`)
    console.log(
      `   💾 Swap Size: ${formatBytes(swapSizeBytes)} (${CONFIG.swapSizeMultiplier}x RAM)`,
    )
    console.log(`   🗑️ Remove ZRAM: ${CONFIG.removeZram ? "✅" : "❌"}`)
    console.log(`   📏 Resize Btrfs: ${CONFIG.resizeBtrfsToMax ? "✅" : "❌"}`)
    console.log(`   📊 Max Swap % of Disk: ${CONFIG.maxSwapPercentageOfDisk}%`)

    // Ask for confirmation
    console.log("\n⚠️  This script will make system changes. Continue? (y/N)")
    const confirmation = prompt("Enter your choice:")
    if (confirmation?.toLowerCase() !== "y" && confirmation?.toLowerCase() !== "yes") {
      await log("❌ User cancelled the operation")
      console.log("Operation cancelled.")
      return
    }

    // Execute configuration steps
    console.log("\n🚀 Starting hibernation configuration...")

    await removeZramIfEnabled()
    await restoreBtrfsFilesystem()
    await createHibernationSwap(swapSizeBytes)
    await enableSwapPermanently()
    await configureHibernationSupport()
    await enableUserHibernationPermissions()
    await restartPowerManagement()
    await performVerificationTests()

    console.log("\n🎉 Hibernation configuration completed successfully!")
    console.log("\n📝 Next steps:")
    console.log("   1. 🧪 Test hibernation: systemctl hibernate")
    console.log("   2. 🔋 The hibernation option should appear in KDE power menu immediately")
    console.log("   3. 🔄 UEFI will automatically resume from hibernation")
    console.log("\n💡 Troubleshooting:")
    console.log("   • If hibernation option doesn't appear, try logging out and back in")
    console.log("   • Or restart KDE: kquitapp5 plasmashell && plasmashell &")
    console.log(`\n📋 Full log available at: ${logPath}`)

    await log("🎉 Hibernation configuration completed successfully!", "SUCCESS")
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    await log(`❌ FATAL ERROR: ${errorMessage}`, "ERROR")
    console.error(`\n❌ Error: ${errorMessage}`)
    if (logPath!) {
      console.error(`\n📋 Check the log file for details: ${logPath}`)
    }
    Deno.exit(1)
  }
}

// Run the main function if this script is executed directly
if (import.meta.main) {
  main()
}
