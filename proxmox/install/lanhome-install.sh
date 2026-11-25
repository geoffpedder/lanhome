#!/usr/bin/env bash

# Copyright (c) 2026 geoff pedder
# Author: geoff pedder (geoffpedder)
# License: MIT | https://github.com/geoffpedder/lanhome/raw/main/LICENSE
# Source: https://github.com/geoffpedder/lanhome

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

NODE_VERSION="22" setup_nodejs

fetch_and_deploy_gh_release "lanhome" "geoffpedder/lanhome" "tarball"

msg_info "Installing LAN Home Dependencies"
cd /opt/lanhome
$STD npm ci --omit=dev
msg_ok "Installed LAN Home Dependencies"

msg_info "Configuring LAN Home"
mkdir -p /opt/lanhome_data/{backups,icon-cache}
cat <<EOF >/opt/lanhome_data/.env
PORT=3000
CONFIG=/opt/lanhome_data/config.yml
BACKUP_DIR=/opt/lanhome_data/backups
ICON_CACHE=/opt/lanhome_data/icon-cache
#EDIT_PASSWORD=
EOF
cat <<EOF >/opt/lanhome_data/config.yml
title: Home
grid:
  small: 2
  medium: 2
  large: 3
  xlarge: 4
services:
  Getting started:
    - title: LAN Home
      description: click the pencil to edit
      link: https://github.com/geoffpedder/lanhome
      icon:
        name: simple-icons:github
        wrap: true
EOF
msg_ok "Configured LAN Home"

msg_info "Creating Service"
cat <<EOF >/etc/systemd/system/lanhome.service
[Unit]
Description=LAN Home
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/lanhome
EnvironmentFile=/opt/lanhome_data/.env
ExecStart=/usr/bin/node /opt/lanhome/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl enable -q --now lanhome
msg_ok "Created Service"

motd_ssh
customize
cleanup_lxc
