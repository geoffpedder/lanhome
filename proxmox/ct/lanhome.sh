#!/usr/bin/env bash
_CS_DEFAULT_URL="https://raw.githubusercontent.com/geoffpedder/lanhome/main/proxmox"
_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-$(dirname "${BASH_SOURCE[0]}")/../../core}/core/build.func"
source "$_cs_boot" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/main}/core/build.func")
# Copyright (c) 2026 geoff pedder
# Author: geoff pedder (geoffpedder)
# License: MIT | https://github.com/geoffpedder/lanhome/raw/main/LICENSE
# Source: https://github.com/geoffpedder/lanhome

APP="LAN Home"
var_tags="${var_tags:-dashboard}"
var_cpu="${var_cpu:-1}"
var_ram="${var_ram:-512}"
var_disk="${var_disk:-2}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
#var_arm64="${var_arm64:-no}" # unset = ask the user; set yes/no only when verified
var_unprivileged="${var_unprivileged:-1}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources

  if [[ ! -d /opt/lanhome ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi

  if check_for_gh_release "lanhome" "geoffpedder/lanhome"; then
    msg_info "Stopping LAN Home"
    systemctl stop lanhome
    msg_ok "Stopped LAN Home"

    CLEAN_INSTALL=1 fetch_and_deploy_gh_release "lanhome" "geoffpedder/lanhome" "tarball"

    msg_info "Installing LAN Home Dependencies"
    cd /opt/lanhome
    $STD npm ci --omit=dev
    msg_ok "Installed LAN Home Dependencies"

    msg_info "Starting LAN Home"
    systemctl start lanhome
    msg_ok "Started LAN Home"
    msg_ok "Updated successfully!"
  fi
  exit
}

start
build_container
description

msg_ok "Completed Successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW}Access it using the following URL:${CL}"
echo -e "${GATEWAY}${BGN}http://${IP}:3000${CL}"
