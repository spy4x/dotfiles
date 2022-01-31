#!/bin/bash
set -e

script_dir="$PWD"

echo '▶️  Installing Brew...'
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$($(brew --prefix)/bin/brew shellenv)"' >> ~/.zprofile
eval "$($(brew --prefix)/bin/brew shellenv)"
echo '✅ Brew installation complete \n'

echo '▶️  Installing Apps with Brew...'
brew bundle
# Configure Google Cloud CLI $PATH and autocomplete
echo 'source "$(brew --prefix)/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/path.zsh.inc"' >> ~/.zshrc
echo 'source "$(brew --prefix)/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/completion.zsh.inc"' >> ~/.zshrc
echo '✅ Apps installation complete \n'

echo '▶️  Installing Node.js via NVM...'
# Put NVM dir into .zshrc
echo 'export NVM_DIR="$HOME/.nvm"
[ -s "$(brew --prefix)/opt/nvm/nvm.sh" ] && \. "$(brew --prefix)/opt/nvm/nvm.sh" # This loads nvm
[ -s "$(brew --prefix)/opt/nvm/etc/bash_completion.d/nvm" ] && \. "$(brew --prefix)/opt/nvm/etc/bash_completion.d/nvm" # This loads nvm bash_completion' >> ~/.zshrc
source ~/.zshrc
# Install Node.js
nvm install node
npm i -g yarn
echo '✅ Node.js installation complete \n'

echo '▶️  Configuring custom Spy4x theme for Oh-my-zsh...'
cd "$script_dir"
cp my.zsh-theme ~/.oh-my-zsh/themes/
echo 'ZSH_THEME="my"' >> ~/.zshrc
echo 'source $ZSH/oh-my-zsh.sh' >> ~/.zshrc
source ~/.zshrc
echo '✅ Configuration complete \n'

echo '🎉 If you see this message, then its all done 🎉 \n\n\n'
