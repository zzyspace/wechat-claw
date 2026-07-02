#!/usr/bin/env bash

set -euo pipefail

APP_DIR="/opt/wechat-claw/current"
APP_USER="wechatclaw"
SERVICE_NAME="wechat-claw"
CACHE_DIR=""
ENV_FILE="/etc/wechat-claw.env"
WAIT_SECONDS=5
SKIP_RESTART=0

usage() {
  cat <<'EOF'
Usage:
  deploy/repair-wechat-claw-chromium.sh [options]

Description:
  Restore Puppeteer's Chromium runtime for wechat-claw by ensuring a persistent
  cache exists, downloading Chromium when missing, re-binding
  node_modules/puppeteer/.local-chromium to the persistent cache, and
  optionally restarting the main service.

Options:
  --app-dir <path>        Application directory. Default: /opt/wechat-claw/current
  --app-user <user>       Application runtime user. Default: wechatclaw
  --service-name <name>   systemd service name to restart. Default: wechat-claw
  --cache-dir <path>      Puppeteer cache directory.
                          Default: <app-dir>/.cache/puppeteer
  --env-file <path>       Reserved for future config resolution. Default: /etc/wechat-claw.env
  --wait-seconds <n>      Seconds to wait after restart before printing status.
                          Default: 5
  --skip-restart          Repair files only; do not restart the service.
  -h, --help              Show help.

Examples:
  sudo bash deploy/repair-wechat-claw-chromium.sh
  sudo bash deploy/repair-wechat-claw-chromium.sh --skip-restart
  sudo bash deploy/repair-wechat-claw-chromium.sh --service-name wechat-claw --wait-seconds 8
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir)
      APP_DIR="$2"
      shift 2
      ;;
    --app-user)
      APP_USER="$2"
      shift 2
      ;;
    --service-name)
      SERVICE_NAME="$2"
      shift 2
      ;;
    --cache-dir)
      CACHE_DIR="$2"
      shift 2
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --wait-seconds)
      WAIT_SECONDS="$2"
      shift 2
      ;;
    --skip-restart)
      SKIP_RESTART=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run this script as root or with sudo." >&2
  exit 1
fi

for cmd in sudo systemctl node; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing required command: ${cmd}" >&2
    exit 1
  fi
done

if ! [[ "${WAIT_SECONDS}" =~ ^[0-9]+$ ]]; then
  echo "Invalid --wait-seconds value: ${WAIT_SECONDS}" >&2
  exit 1
fi

if [[ ! -d "${APP_DIR}" ]]; then
  echo "Application directory does not exist: ${APP_DIR}" >&2
  exit 1
fi

if [[ ! -d "${APP_DIR}/node_modules/puppeteer" ]]; then
  echo "Puppeteer package directory does not exist: ${APP_DIR}/node_modules/puppeteer" >&2
  exit 1
fi

if [[ ! -f "${APP_DIR}/node_modules/puppeteer/install.js" ]]; then
  echo "Missing Puppeteer install script: ${APP_DIR}/node_modules/puppeteer/install.js" >&2
  exit 1
fi

if [[ -z "${CACHE_DIR}" ]]; then
  CACHE_DIR="${APP_DIR}/.cache/puppeteer"
fi

run_as_app_user() {
  sudo -u "${APP_USER}" -H bash -lc "cd '${APP_DIR}' && $*"
}

cache_has_chromium() {
  local path="$1"

  if [[ ! -d "${path}" ]]; then
    return 1
  fi

  find "${path}" -maxdepth 3 -type f \( -name chrome -o -name chrome.exe \) | grep -q .
}

echo "[repair-chromium] App dir: ${APP_DIR}"
echo "[repair-chromium] App user: ${APP_USER}"
echo "[repair-chromium] Service: ${SERVICE_NAME}"
echo "[repair-chromium] Env file: ${ENV_FILE}"
echo "[repair-chromium] Cache dir: ${CACHE_DIR}"

echo "[repair-chromium] Ensuring persistent cache directory exists"
run_as_app_user "mkdir -p '${CACHE_DIR}'"

if cache_has_chromium "${CACHE_DIR}"; then
  echo "[repair-chromium] Chromium cache already present"
else
  echo "[repair-chromium] Chromium cache missing, downloading via Puppeteer"
  run_as_app_user "PUPPETEER_DOWNLOAD_PATH='${CACHE_DIR}' node node_modules/puppeteer/install.js"

  if ! cache_has_chromium "${CACHE_DIR}"; then
    echo "[repair-chromium] Chromium download did not produce an executable browser in ${CACHE_DIR}" >&2
    exit 1
  fi
fi

echo "[repair-chromium] Rebinding Puppeteer runtime path"
run_as_app_user "rm -rf 'node_modules/puppeteer/.local-chromium' && ln -sfn '${CACHE_DIR}' 'node_modules/puppeteer/.local-chromium'"

if [[ "${SKIP_RESTART}" -eq 1 ]]; then
  echo "[repair-chromium] Skip restart requested; repair completed"
  exit 0
fi

echo "[repair-chromium] Restarting ${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

if [[ "${WAIT_SECONDS}" -gt 0 ]]; then
  echo "[repair-chromium] Waiting ${WAIT_SECONDS}s before printing status"
  sleep "${WAIT_SECONDS}"
fi

echo "[repair-chromium] Service status"
systemctl --no-pager --full status "${SERVICE_NAME}"

echo "[repair-chromium] Recent logs"
journalctl -u "${SERVICE_NAME}" -n 60 --no-pager
