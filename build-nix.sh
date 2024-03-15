#!/bin/sh

# Make sure that the script exits if any command returns a non-zero exit code
set -e

# Define the path to the system configuration file
NIXOS_CONFIG_PATH="/etc/nixos"

echo "Checking for sudo access..."
# Ensure the script is being run with superuser privileges
sudo -v

echo "Copying new configuration..."
# Copy the local configuration.nix to the system configuration location
sudo cp ./configuration.nix "${NIXOS_CONFIG_PATH}"
sudo mkdir -p "${NIXOS_CONFIG_PATH}/private"
sudo cp ./private/* "${NIXOS_CONFIG_PATH}/private/"

echo "Rebuilding NixOS configuration..."
# Rebuild the NixOS configuration and make the changes effective
sudo nixos-rebuild switch

echo "NixOS configuration updated successfully."