#!/usr/bin/env bash
# install.sh — piped via wget:
#   wget -qO- https://raw.githubusercontent.com/yourorg/SiegeUpLauncher/main/install.sh | bash

set -euo pipefail

# 1) create service user
if ! id siegeuplauncher &>/dev/null; then
  useradd --create-home --shell /bin/bash siegeuplauncher
fi

# 2) clone & install
LAUNCH_DIR="/home/siegeuplauncher/launcher"
if [[ ! -d $LAUNCH_DIR ]]; then
  sudo -u siegeuplauncher git clone \
    https://github.com/yourorg/SiegeUpLauncher.git "$LAUNCH_DIR"
fi

cd "$LAUNCH_DIR"
npm ci --omit=dev

# 3) systemd unit
cat >/etc/systemd/system/siegeup-launcher.service <<EOF
[Unit]
Description=SiegeUp Game Launcher
After=network.target

[Service]
Type=simple
User=siegeuplauncher
WorkingDirectory=$LAUNCH_DIR
ExecStartPre=/usr/bin/git pull origin main
ExecStart=$(which node) launcher.js --port=8443
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# 4) enable & start
systemctl daemon-reload
systemctl enable --now siegeup-launcher
