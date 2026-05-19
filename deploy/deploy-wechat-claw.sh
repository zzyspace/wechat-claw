#!/usr/bin/env bash

set -euo pipefail

APP_DIR="/opt/wechat-claw/current"
APP_USER="wechatclaw"
ENV_FILE="/etc/wechat-claw.env"
SERVICE_NAME="wechat-claw"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run this script as root or with sudo." >&2
  exit 1
fi

for cmd in git npm systemctl sudo; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing required command: ${cmd}" >&2
    exit 1
  fi
done

if [[ ! -d "${APP_DIR}" ]]; then
  echo "Application directory does not exist: ${APP_DIR}" >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Environment file does not exist: ${ENV_FILE}" >&2
  exit 1
fi

run_as_app_user() {
  sudo -u "${APP_USER}" -H bash -lc "cd '${APP_DIR}' && $*"
}

echo "[deploy] Pulling latest code from origin/main"
run_as_app_user "git pull --ff-only origin main"

echo "[deploy] Installing production dependencies"
run_as_app_user "npm ci"

echo "[deploy] Building TypeScript output"
run_as_app_user "npm run build"

echo "[deploy] Running doctor checks with production environment"
set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a
sudo -u "${APP_USER}" -E -H bash -lc "cd '${APP_DIR}' && npm run doctor"

echo "[deploy] Restarting ${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"
sleep 5

echo "[deploy] Service status"
systemctl --no-pager --full status "${SERVICE_NAME}"
