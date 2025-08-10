# Hibernation Setup Success Guide - Fedora 42 KDE

**Date**: August 10, 2025
**Result**: ✅ WORKING hibernation on Fedora 42 KDE with Btrfs
**Method**: UEFI variables instead of manual GRUB resume parameters
**Reference**: https://fedoramagazine.org/update-on-hibernation-in-fedora-workstation/
**Total setup time**: ~10 minutes
**Success rate**: High (modern UEFI method)
**Maintenance**: None required after setup


## System Requirements

- **OS**: Fedora 42 KDE
- **Filesystem**: Btrfs
- **Boot**: UEFI (required - check with `bootctl`)
- **RAM**: Any size (this guide uses 91GB → 136GB swap)

## Quick Success Steps

### 1. Restore Btrfs Filesystem (if previously resized)

```bash
sudo btrfs filesystem resize max /
```

### 2. Create Hibernation Swap

```bash
# Set swap size (1.5x RAM recommended)
SWAPSIZE="136G"  # Adjust for your RAM size

# Create Btrfs subvolume and swapfile
sudo btrfs subvolume create /var/swap
sudo chattr +C /var/swap
sudo restorecon /var/swap
sudo btrfs filesystem mkswapfile --size $SWAPSIZE --uuid clear /var/swap/swapfile
```

### 3. Enable Swap Permanently

```bash
echo "/var/swap/swapfile none swap defaults 0 0" | sudo tee --append /etc/fstab
sudo swapon --all --verbose
```

### 4. Configure Hibernation Support

```bash
# Add dracut resume module
echo 'add_dracutmodules+=" resume "' | sudo tee /etc/dracut.conf.d/resume.conf
sudo dracut --force

# Fix SELinux contexts (prevents "Access denied")
sudo semanage fcontext --add --type swapfile_t /var/swap/swapfile
sudo restorecon -RF /var/swap
```

### 5. Enable User Hibernation Permissions

```bash
sudo mkdir -p /etc/polkit-1/localauthority/50-local.d/
sudo tee /etc/polkit-1/localauthority/50-local.d/hibernate.pkla << 'EOF'
[Allow hibernation]
Identity=unix-user:*
Action=org.freedesktop.login1.hibernate;org.freedesktop.login1.hibernate-multiple-sessions
ResultActive=yes
EOF
sudo systemctl restart polkit
```

### 6. Restart Power Management

```bash
systemctl --user restart plasma-powerdevil
```

## Verification

```bash
# Check swap is active
swapon --show
# Should show: /var/swap/swapfile file 136G 0B -2

# Check hibernation support
cat /sys/power/state
# Should show: freeze mem disk

# Test hibernation (dry run)
systemctl hibernate --dry-run
# Should complete without errors

# Test actual hibernation (save work first!)
systemctl hibernate
```

## Why This Works

1. **UEFI Automatic Resume**: No manual GRUB configuration needed
2. **Native Btrfs Support**: Uses `btrfs filesystem mkswapfile`
3. **Proper SELinux**: Prevents access denied errors
4. **Modern systemd**: Handles hibernation location automatically
5. **Subvolume Isolation**: Protects swapfile from snapshots

## Key Success Factors

- ✅ Use UEFI-based method (not manual GRUB editing)
- ✅ Use native Btrfs swapfile tools
- ✅ Set proper SELinux contexts
- ✅ Create dedicated Btrfs subvolume
- ✅ Size swap at 1.5x RAM for safety

## Troubleshooting

### "Access denied" when hibernating

```bash
# Fix SELinux context
sudo semanage fcontext --add --type swapfile_t /var/swap/swapfile
sudo restorecon -RF /var/swap
```

### Hibernation option missing in KDE

```bash
# Restart power management
systemctl --user restart plasma-powerdevil
```

### "swapon failed: Invalid argument"

```bash
# Ensure CoW is disabled
sudo chattr +C /var/swap
```
