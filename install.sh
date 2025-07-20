#!/usr/bin/env bash

set -euo pipefail

# 0) Prerequisites
apt-get update
apt-get install -y curl git build-essential unzip

# 1) Install Node.js and npm (using nvm for latest LTS)
export NVM_DIR="/usr/local/nvm"
if [[ ! -d $NVM_DIR ]]; then
  mkdir -p "$NVM_DIR"
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
fi

# Load nvm
export NVM_DIR="/usr/local/nvm"
source "$NVM_DIR/nvm.sh"

# Install and use latest LTS
nvm install --lts
nvm use --lts
nvm alias default 'lts/*'

# Ensure global access for node and npm
ln -sf "$(command -v node)" /usr/bin/node
ln -sf "$(command -v npm)"  /usr/bin/npm

# 2) Create service user if missing
if ! id siegeuplauncher &>/dev/null; then
  useradd --create-home --shell /bin/bash siegeuplauncher
fi

# 3) Clone repo
LAUNCH_DIR="/home/siegeuplauncher/launcher"
if [[ ! -d $LAUNCH_DIR ]]; then
  sudo -u siegeuplauncher git clone \
    https://github.com/SiegeUp/ServerLauncher.git "$LAUNCH_DIR"
fi

cd "$LAUNCH_DIR"
sudo -u siegeuplauncher npm ci --omit=dev

# 4) Create systemd service
cat >/etc/systemd/system/siegeup-launcher.service <<EOF
[Unit]
Description=SiegeUp Game Launcher
After=network.target

[Service]
Type=simple
User=siegeuplauncher
WorkingDirectory=$LAUNCH_DIR
ExecStartPre=/usr/bin/git pull origin main
ExecStart=/usr/bin/node launcher.js --port=8443
Restart=always
RestartSec=5
EnvironmentFile=/etc/environment

[Install]
WantedBy=multi-user.target
EOF

# 5) Enable and start the service
systemctl daemon-reload
systemctl enable --now siegeup-launcher
