# Dotfiles

In this repo I store my config files.
- `Brewfile` for macOS (I'm about to drop it).
- `configuration.nix` for NixOS (a new linux distro for me, that I'm exploring as a replacement for macOS).
It helps me to install quickly all software I need for work and fun.
Feel free to check & alter the list of software to be installed in these files.

## Installation

### macOS/Brew
1. Install Brew from here: https://brew.sh/
2. Copy Brewfile to your computer and run `brew bundle` from the same folder where you copied the file.
3. Run `chmod +x ./cron-adjust-microphone-gain-to-100.sh` and `./cron-adjust-microphone-gain-to-100.sh` [to change microphone gain to 100% on macOS](https://apple.stackexchange.com/questions/97810/mac-osx-microphone-input-volume-level-auto-adjusts-can-it-be-disabled).

Note: Brew will ask you for the root password and other apps inside Brewfile might ask you for your password as well.  
Usually installation takes 10-20 min, so make sure to brew a cup of tea or coffee :)

### NixOS
1. `chmod +x ./build-nix.sh`
2. [Optionally] SSH Config `cp ./ssh-config.nix.example ./ssh-config.nix` and fill with your values.
3. [First run] `./build-nix.sh` or [then] just `make`