# Edit this configuration file to define what should be installed on
# your system.  Help is available in the configuration.nix(5) man page
# and in the NixOS manual (accessible by running ‘nixos-help’).

{ config, pkgs, lib, ... }:

let
  sshConfigPath = ./ssh-config.nix;
in
{
  imports =
    [
      # Include the results of the hardware scan.
      ./hardware-configuration.nix
    ] ++ lib.optional (builtins.pathExists sshConfigPath) sshConfigPath;

  # Bootloader.
  boot.loader.grub.enable = true;
  boot.loader.grub.device = "/dev/nvme0n1";
  boot.loader.grub.useOSProber = true;

  networking.hostName = "spy4x-pc";
  networking.networkmanager.enable = true;
  networking = {
    firewall = {
      enable = true;
      allowedTCPPorts = [
        80 # Web server to debug apps from mobile
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
  # virtualisation.docker.enableNvidia = true; # experiment for Roley?

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

  # Define a user account. Don't forget to set a password with ‘passwd’.
  users.users.spy4x = {
    isNormalUser = true;
    description = "Anton Shubin";
    extraGroups = [
      "networkmanager"
      "wheel"
      "bluetooth"
      "docker"
    ];
    packages = with pkgs; [
      # Shell tools
      git
      gnumake # Source for "make" command
      htop # System monitor viewer
      unzip
      killall # Kill processes by name instead of PID
      ncdu # Disk space usage stats, per folder, nested
      libwebp # Convert images into .webp format
      wl-clipboard # Wayland's clipboard copy/paste cli tools
      tree
      nixpkgs-fmt # Formatter for .nix files. Like Prettier.

      # Work
      nodejs_21
      nodePackages.pnpm
      vscode-fhs # Wrapped variant of vscode which launches in a FHS compatible environment. Should allow for easy usage of extensions without nix-specific modifications.
      jetbrains.webstorm
      upwork
      slack
      ffmpeg # for Roley project
      awscli

      # Other
      google-chrome
      bitwarden # Password manager client
      vlc
      obs-studio # Video recorder and stream software
      solaar # Logitech devices GUI. Strictly use with sudo, otherwise it doesn't see devices.
      localsend # Share files/text/data with other devices in local network without internet. OSS alternative to AirDrop.
    ];
  };
  programs.steam.enable = true; # Install Steam for games management

  # Shell aliases and other init
  environment.interactiveShellInit = ''
    alias copy='wl-copy <'
    alias build='sudo nixos-rebuild switch'
  '';

  # Enable automatic login for the user.
  services.xserver.displayManager.autoLogin.enable = true;
  services.xserver.displayManager.autoLogin.user = "spy4x";

  # Workaround for GNOME autologin: https://github.com/NixOS/nixpkgs/issues/103746#issuecomment-945091229
  systemd.services."getty@tty1".enable = false;
  systemd.services."autovt@tty1".enable = false;

  system.stateVersion = "23.11";
}
