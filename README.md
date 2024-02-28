# Dotfiles

This repository is my setup for a new MacOS computer.  
It helps me to install quickly all software I need for work and fun.
Feel free to check & alter the list of software to be installed - [Brewfile](Brewfile).

Additionally I install next software, that is not (yet) presented in Brew:

- Upwork
- Toggl Track

## Installation

1. Install Brew from here: https://brew.sh/
2. Copy Brewfile to your computer and run `brew bundle` from the same folder where you copied the file.
3. Run `chmod +x ./cron-adjust-microphone-gain-to-100.sh` and `./cron-adjust-microphone-gain-to-100.sh` [to change microphone gain to 100% on macOS](https://apple.stackexchange.com/questions/97810/mac-osx-microphone-input-volume-level-auto-adjusts-can-it-be-disabled).

Note: Brew will ask you for the root password and other apps inside Brewfile might ask you for your password as well.  
Usually installation takes 10-20 min, so make sure to brew a cup of tea or coffee :)
