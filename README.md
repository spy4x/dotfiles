# Dotfiles

In this repo I store my config files.
It helps me to install quickly all software I need for work and fun.  
Feel free to check & alter the list of software to be installed in these files.

I use NixOS. It stores all of it's configuration in `configuration.nix`.
That's where you can start exploration and modification.

## Install

1. Clone this repo.
2. Give build script permission to execute: `chmod +x ./build-nix.sh`.
2. [Optionally] SSH Config `cp ./ssh-config.nix.example ./ssh-config.nix` and fill with your values.
3. Apply configuration with `make`.

## Usage

1. Change configuration files to desired state.
2. Apply configuration with `make`.