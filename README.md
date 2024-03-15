# Dotfiles

In this repo I store my config files.
It helps me to install quickly all software I need for work and fun.  
Feel free to check & alter the configs as you like.

I use NixOS. It stores all of its configuration in `configuration.nix`.  
Start your exploration there.  
If you are confused at any step - checkout docs on https://nixos.org/

## Install

1. Clone this repo.
2. Give build script permission to execute: `chmod +x ./build-nix.sh`.
3. [Optionally] Check example files in `./private` folder. If anything there you'd like to use - copy example file and remove ".example" suffix. Fill file with your content. Example: SSH Config `cp ./private/ssh-config.nix.example ./private/ssh-config.nix` and fill with your values.
4. Apply configuration with `make`.

## Usage

1. Change configuration files to desired state.
2. Apply configuration with `make`.