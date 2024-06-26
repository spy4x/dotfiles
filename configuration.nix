{ config, pkgs, lib, ... }:

let
  personal = import ./private/personal.nix;

  gdrivePath = "/home/${personal.username}/gdrive";
  curBin = "/run/current-system/sw/bin";
  nixFolder = "/etc/nixos";

  sshConfigPath = "${nixFolder}/private/ssh-config";
  sshConfig = if builtins.pathExists "${sshConfigPath}" then builtins.readFile "${sshConfigPath}" else "# private ssh config file didn't exist to insert it's content here";

  aliasesPath = "${nixFolder}/aliases.sh";
  aliases = if builtins.pathExists "${aliasesPath}" then builtins.readFile "${aliasesPath}" else "# aliases file didn't exist to insert it's content here";

  home-manager = builtins.fetchTarball "https://github.com/nix-community/home-manager/archive/release-24.05.tar.gz";
in
{
  imports =
    [
      # Include the results of the hardware scan.
      ./hardware-configuration.nix
      (import "${home-manager}/nixos")
    ];

  # Bootloader.
  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = true;

  networking = {
    hostName = "${personal.username}-${personal.deviceName}";
    networkmanager.enable = true;
    firewall = {
      enable = true;
      allowedTCPPorts = [
        # BEGIN Web server to debug apps from mobile
        80
        4200
        4201
        5173
        5174
        8080
        8081
        # END Web server to debug apps from mobile
        53317 # LocalSend
      ];
    };
  };

  # Allow install "unfree" apps, like Google Chrome or WebStorm
  nixpkgs.config.allowUnfree = true;

  time.timeZone = "Asia/Singapore";

  i18n.defaultLocale = "en_SG.UTF-8";
  i18n.extraLocaleSettings = {
    LC_ADDRESS = "en_SG.UTF-8";
    LC_IDENTIFICATION = "en_SG.UTF-8";
    LC_MEASUREMENT = "en_SG.UTF-8";
    LC_MONETARY = "en_SG.UTF-8";
    LC_NAME = "en_SG.UTF-8";
    LC_NUMERIC = "en_SG.UTF-8";
    LC_PAPER = "en_SG.UTF-8";
    LC_TELEPHONE = "en_SG.UTF-8";
    LC_TIME = "en_SG.UTF-8";
  };

  # Enable the X11 windowing system.
  services.xserver.enable = true;

  # Enable the GNOME Desktop Environment.
  services.xserver.displayManager.gdm.enable = true;
  services.xserver.desktopManager.gnome.enable = true;

  # Configure keymap in X11
  services.xserver = {
    layout = "us";
    xkbVariant = "";
  };

  # Activate and configure Docker
  virtualisation.docker.enable = true;
  virtualisation.docker.autoPrune.enable = true;

  # Enable sound with pipewire.
  sound.enable = true;
  hardware.pulseaudio.enable = false;
  security.rtkit.enable = true;
  services.pipewire = {
    enable = true;
    alsa.enable = true;
    alsa.support32Bit = true;
    pulse.enable = true;
  };

  # Logitech devices manager "Solaar". Gives necessary permissions to run it without "sudo.
  hardware.logitech.wireless.enable = true;
  hardware.logitech.wireless.enableGraphical = true;

  # Define a user account. Don't forget to set a password with ‘passwd’.
  users.users.spy4x = {
    isNormalUser = true;
    description = personal.userFullName;
    extraGroups = [
      "networkmanager"
      "wheel"
      "bluetooth"
      "docker"
    ];
    shell = pkgs.zsh;
  };

  # Install firefox.
  programs.firefox.enable = true;

  home-manager.users.spy4x = {
    home.stateVersion = "24.05";
    home.username = personal.username;
    home.homeDirectory = "/home/${personal.username}";

    home.packages = with pkgs; [
      # Shell tools BEGIN
      git
      gnumake # Source for "make" command
      htop # System monitor viewer
      zip
      unzip
      killall # Kill processes by name instead of PID
      ncdu # Disk space usage stats, per folder, nested
      libwebp # Convert images into .webp format
      wl-clipboard # Wayland's clipboard copy/paste cli tools
      tree
      nixpkgs-fmt # Formatter for .nix files. Like Prettier.
      envsubst # Is used in homelab deploy for building homepage
      zsh
      zsh-powerlevel10k
      # Shell tools END

      # Work BEGIN
      nodejs_22
      nodePackages.pnpm
      vscode-fhs # Wrapped variant of vscode which launches in a FHS compatible environment. Should allow for easy usage of extensions without nix-specific modifications.
      jetbrains.webstorm
      upwork # requires manual download and a command execution to register .deb file
      slack
      ffmpeg # for Roley project, check if still actual after 01.01.2025
      awscli # for Roley project, check if still actual after 01.01.2025
      # Work END

      # Other BEGIN
      bitwarden # Password manager client
      vlc
      obs-studio # Video recorder and stream software
      localsend # Share files/text/data with other devices in local network without internet. OSS alternative to AirDrop.
      rclone # Sync Google Drive with a local folder
      bottles # Gaming time! Wine wrapper for Windows games and apps
      wireguard-tools # VPN CLI client
      transmission-qt # Torrent client
      # Other END
    ];

    programs.ssh.enable = true;
    programs.ssh.extraConfig = ''
      ${sshConfig}
    '';
  };

  programs.steam.enable = true; # Install Steam for games management

  programs.zsh = {
    enable = true;
    syntaxHighlighting.enable = true;
    autosuggestions.enable = true;
    ohMyZsh.enable = true;
    promptInit = "source ${pkgs.zsh-powerlevel10k}/share/zsh-powerlevel10k/powerlevel10k.zsh-theme";
  };

  # Shell aliases and other init
  environment.interactiveShellInit = ''
    ${aliases}
  '';


  # Enable automatic login for the user.
  services.xserver.displayManager.autoLogin.enable = true;
  services.xserver.displayManager.autoLogin.user = personal.username;

  # RClone Google Drive service - requires "$ rclone config" to be configured for Google Drive first
  systemd.services.rclone-gdrive-mount = {
    # Ensure the service starts after the network is up
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" ];
    requires = [ "network-online.target" ];

    # Service configuration
    serviceConfig = {
      Type = "simple";
      ExecStartPre = "${curBin}/mkdir -p ${gdrivePath}";
      ExecStart = "${pkgs.rclone}/bin/rclone mount gdrive: ${gdrivePath} --vfs-cache-mode full --vfs-cache-max-age 72h --vfs-cache-max-size 100G --vfs-read-ahead 2G";
      ExecStop = "${curBin}/fusermount -u ${gdrivePath}";
      Restart = "on-failure";
      RestartSec = "10s";
      User = personal.username;
      Group = "users";
      Environment = [ "PATH=/run/wrappers/bin/:$PATH" ]; # Required environments
    };
  };

  system.stateVersion = "24.05";
}
