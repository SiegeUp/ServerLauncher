#!/usr/bin/env bash

set -euo pipefail

SERVICE_NAME="siegeup-launcher"
USER_NAME="siegeuplauncher"

echo "Stopping and disabling systemd service..."
systemctl stop "$SERVICE_NAME" || true
systemctl disable "$SERVICE_NAME" || true
rm -f "/etc/systemd/system/$SERVICE_NAME.service"

echo "Reloading systemd..."
systemctl daemon-reload

if id "$USER_NAME" &>/dev/null; then
  echo "Deleting user $USER_NAME and home directory..."
  userdel -r "$USER_NAME" || true
else
  echo "User $USER_NAME does not exist, skipping."
fi

echo "Uninstallation complete."
