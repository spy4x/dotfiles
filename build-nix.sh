#!/bin/sh

# Make sure that the script exits if any command returns a non-zero exit code
set -e

# Define the path to the system configuration file
NIXOS_CONFIG_PATH="/etc/nixos"

# Get the current date in YYYYMMDD format
BACKUP_DATE=$(date +%Y%m%d)

echo "Checking for sudo access..."
# Ensure the script is being run with superuser privileges
sudo -v

# Backup the existing configuration.nix file with date suffix
echo "Backing up existing configuration.nix..."
sudo cp "${NIXOS_CONFIG_PATH}/configuration.nix" "${NIXOS_CONFIG_PATH}/configuration.nix.bak.${BACKUP_DATE}"

echo "Copying new configuration..."
# Copy the local configuration.nix to the system configuration location
sudo cp ./configuration.nix "${NIXOS_CONFIG_PATH}"
sudo mkdir -p "${NIXOS_CONFIG_PATH}/private"
sudo cp ./private/* "${NIXOS_CONFIG_PATH}/private/"
sudo cp ./aliases.sh "${NIXOS_CONFIG_PATH}"

echo "Rebuilding NixOS configuration..."
# Rebuild the NixOS configuration and make the changes effective
sudo nixos-rebuild switch

echo "NixOS configuration updated successfully."
