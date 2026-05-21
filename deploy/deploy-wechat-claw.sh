#!/usr/bin/env bash

set -euo pipefail

APP_DIR="/opt/wechat-claw/current"
APP_USER="wechatclaw"
ENV_FILE="/etc/wechat-claw.env"
SERVICE_NAME="wechat-claw"
WATCHDOG_SERVICE_NAME="wechat-claw-watchdog"
WATCHDOG_TIMER_NAME="wechat-claw-watchdog"
SYSTEMD_UNIT_DIR="/etc/systemd/system"
NEEDRESTART_CONF_DIR="/etc/needrestart/conf.d"
PUPPETEER_CACHE_DIR="${APP_DIR}/.cache/puppeteer"
WITH_ENV_SOURCE=""

usage() {
  cat <<'EOF'
Usage:
  deploy-wechat-claw [--with-env <server-env-file>]

Options:
  --with-env <server-env-file>  Install a server-local env file to /etc/wechat-claw.env before deploy
  -h, --help                    Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-env)
      WITH_ENV_SOURCE="$2"
      shift 2
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

for cmd in git install node npm systemctl sudo; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing required command: ${cmd}" >&2
    exit 1
  fi
done

if [[ ! -d "${APP_DIR}" ]]; then
  echo "Application directory does not exist: ${APP_DIR}" >&2
  exit 1
fi

if [[ -n "${WITH_ENV_SOURCE}" ]]; then
  if ! command -v install-wechat-claw-env >/dev/null 2>&1; then
    echo "Missing required command: install-wechat-claw-env" >&2
    exit 1
  fi

  echo "[deploy] Installing environment file from ${WITH_ENV_SOURCE}"
  install-wechat-claw-env "${WITH_ENV_SOURCE}" "${ENV_FILE}"
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Environment file does not exist: ${ENV_FILE}" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
service_source="${script_dir}/wechat-claw.service"
service_target="${SYSTEMD_UNIT_DIR}/${SERVICE_NAME}.service"
watchdog_service_source="${script_dir}/wechat-claw-watchdog.service"
watchdog_service_target="${SYSTEMD_UNIT_DIR}/${WATCHDOG_SERVICE_NAME}.service"
watchdog_timer_source="${script_dir}/wechat-claw-watchdog.timer"
watchdog_timer_target="${SYSTEMD_UNIT_DIR}/${WATCHDOG_TIMER_NAME}.timer"
needrestart_source="${script_dir}/needrestart-wechat-claw.conf"
needrestart_target="${NEEDRESTART_CONF_DIR}/${SERVICE_NAME}.conf"

run_as_app_user() {
  sudo -u "${APP_USER}" -H bash -lc "cd '${APP_DIR}' && $*"
}

validate_installed_dependency_tree() {
  APP_DIR_ENV="${APP_DIR}" node <<'EOF'
const fs = require("node:fs");
const path = require("node:path");

const appDir = process.env.APP_DIR_ENV;
const lockfile = JSON.parse(
  fs.readFileSync(path.join(appDir, "package-lock.json"), "utf8"),
);

for (const [relativePath, pkg] of Object.entries(lockfile.packages || {})) {
  if (!relativePath) {
    continue;
  }

  const packageJsonPath = path.join(appDir, relativePath, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    if (pkg.optional) {
      continue;
    }

    console.log(`missing ${relativePath}/package.json`);
    process.exit(1);
  }

  const installedPkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (pkg.version && installedPkg.version !== pkg.version) {
    console.log(
      `version mismatch at ${relativePath}: expected ${pkg.version}, found ${installedPkg.version ?? "(missing)"}`,
    );
    process.exit(1);
  }
}
EOF
}

refresh_postinstall_patch() {
  if [[ -f "${APP_DIR}/scripts/patch-wechaty-puppet-wechat.mjs" ]]; then
    echo "[deploy] Refreshing Wechaty patch on existing node_modules"
    run_as_app_user "node scripts/patch-wechaty-puppet-wechat.mjs"
  fi
}

prepare_puppeteer_cache() {
  echo "[deploy] Preparing persistent Puppeteer cache"
  run_as_app_user "mkdir -p '${PUPPETEER_CACHE_DIR}'"
  run_as_app_user "if [[ -d 'node_modules/puppeteer/.local-chromium' ]] && [[ -z \"\$(ls -A '${PUPPETEER_CACHE_DIR}' 2>/dev/null)\" ]]; then cp -R 'node_modules/puppeteer/.local-chromium/.' '${PUPPETEER_CACHE_DIR}/'; fi"
}

install_dependencies_if_needed() {
  local install_reason tree_validation_output

  if [[ ! -d "${APP_DIR}/node_modules" ]]; then
    install_reason="node_modules is missing"
  elif [[ ! -x "${APP_DIR}/node_modules/.bin/tsc" ]]; then
    install_reason="TypeScript build tool is missing"
  elif [[ ! -f "${APP_DIR}/node_modules/wechaty-puppet-wechat/package.json" ]]; then
    install_reason="wechaty-puppet-wechat is missing"
  else
    if ! tree_validation_output="$(validate_installed_dependency_tree 2>&1)"; then
      install_reason="${tree_validation_output}"
    fi
  fi

  if [[ -n "${install_reason:-}" ]]; then
    echo "[deploy] Installing Node.js dependencies with npm ci (${install_reason})"
    prepare_puppeteer_cache
    run_as_app_user "PUPPETEER_DOWNLOAD_PATH='${PUPPETEER_CACHE_DIR}' npm ci --include=dev"
    refresh_postinstall_patch
    return
  fi

  echo "[deploy] Skipping npm ci (installed dependency tree matches package-lock.json)"
  refresh_postinstall_patch
}

echo "[deploy] Pulling latest code from origin/main"
run_as_app_user "git pull --ff-only origin main"

if systemctl list-unit-files "${WATCHDOG_TIMER_NAME}.timer" >/dev/null 2>&1; then
  echo "[deploy] Stopping watchdog timer during deploy"
  systemctl stop "${WATCHDOG_TIMER_NAME}.timer" "${WATCHDOG_SERVICE_NAME}.service" || true
fi

if [[ -f "${service_source}" ]]; then
  echo "[deploy] Installing systemd unit"
  install -m 644 -o root -g root "${service_source}" "${service_target}"
fi

if [[ -f "${watchdog_service_source}" ]]; then
  echo "[deploy] Installing watchdog service unit"
  install -m 644 -o root -g root "${watchdog_service_source}" "${watchdog_service_target}"
fi

if [[ -f "${watchdog_timer_source}" ]]; then
  echo "[deploy] Installing watchdog timer unit"
  install -m 644 -o root -g root "${watchdog_timer_source}" "${watchdog_timer_target}"
fi

if [[ -f "${needrestart_source}" ]]; then
  echo "[deploy] Installing needrestart override"
  install -d -m 755 -o root -g root "${NEEDRESTART_CONF_DIR}"
  install -m 644 -o root -g root "${needrestart_source}" "${needrestart_target}"
fi

echo "[deploy] Reloading systemd daemon"
systemctl daemon-reload

install_dependencies_if_needed

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

if [[ -f "${watchdog_service_source}" && -f "${watchdog_timer_source}" ]]; then
  echo "[deploy] Enabling watchdog timer"
  systemctl enable --now "${WATCHDOG_TIMER_NAME}.timer"
fi

echo "[deploy] Service status"
systemctl --no-pager --full status "${SERVICE_NAME}"
