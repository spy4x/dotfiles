# Dotfiles

In this repo I store config files for my development environment.
It helps me to install quickly all software I need for work and fun.  
Feel free to check & alter the configs as you like.

## Install apps on Windows via Winget:
To run Winget - open Terminal app as Administrator.
Install apps from the file (run inside this folder):
```
winget import -i .\packages.json
```

Search for apps inside Winget repository using helpers like: 
1. https://winstall.app
2. https://winget.run

Export apps to the file (exports some Microsoft shit too, unfortunately, but can be manually removed from the file):
```
winget import -i .\packages.json
```

## Install stuff inside WSL2 + Ubuntu:

1. Install Zsh: `sudo apt update && sudo apt install zsh`
2. Install Oh My Zsh: `sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"`
3. Install Powerlevel10k: `git clone --depth=1 https://github.com/romkatv/powerlevel10k.git ${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/themes/powerlevel10k`
4. Set ZSH_THEME="powerlevel10k/powerlevel10k" in `~/.zshrc`.
5. On first start, run `p10k configure` to set up the theme.
6. Copy content of `./aliases.sh` to `~/.zshrc`: `cat ./aliases.sh >> ~/.zshrc`
