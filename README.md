# Dotfiles
This repository is my setup for a new MacOS computer.   
It helps me to install quickly all software I need for work and fun.

Feel free to check & alter the list of software to be installed - [Brewfile](Brewfile)

Also don't hesitate to share your feedback about [install.sh](install.sh) - I'm not a big fun of Shell, so my script may suck :D

Use at your own risk!

## Installation
Run next commands in your terminal one by one and follow instructions if any.  
Note: Brew installation will ask you for the root password.   
And it takes 15-30 min, so make sure to grab your favourite tea or coffee meanwhile.
```shell
# Install oh-my-zsh (it restarts shell, so it has to be separate)
sh -c "$(curl -fsSL https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"

# Main installation script (make sure you use `zsh` to run the script, otherwise you'll run into weird errors)
zsh ./install.sh
```
