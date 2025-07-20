#!/usr/bin/env bash

set -euo pipefail

# 0) Prerequisites
apt-get update
apt-get install -y curl git build-essential unzip

# 1) Install Node.js LTS + npm via NodeSource
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
apt-get install -y nodejs

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
