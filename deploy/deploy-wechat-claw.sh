#!/usr/bin/env bash

set -euo pipefail

APP_DIR="/opt/wechat-claw/current"
APP_USER="wechatclaw"
ENV_FILE="/etc/wechat-claw.env"
SERVICE_NAME="wechat-claw"
SYSTEMD_UNIT_DIR="/etc/systemd/system"
NEEDRESTART_CONF_DIR="/etc/needrestart/conf.d"
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
needrestart_source="${script_dir}/needrestart-wechat-claw.conf"
needrestart_target="${NEEDRESTART_CONF_DIR}/${SERVICE_NAME}.conf"

run_as_app_user() {
  sudo -u "${APP_USER}" -H bash -lc "cd '${APP_DIR}' && $*"
}

compute_normalized_lock_signature() {
  local lockfile_path="$1"

  LOCKFILE_PATH="${lockfile_path}" node <<'EOF'
const fs = require("node:fs");
const crypto = require("node:crypto");

function stable(value) {
  if (Array.isArray(value)) {
    return value.map(stable);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }

  return value;
}

const lockfilePath = process.env.LOCKFILE_PATH;
const lockfile = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));

if (lockfile.packages) {
  delete lockfile.packages[""];
}

const normalized = JSON.stringify(stable(lockfile));
const hash = crypto.createHash("sha256").update(normalized).digest("hex");
process.stdout.write(`${hash}\n`);
EOF
}

refresh_postinstall_patch() {
  if [[ -f "${APP_DIR}/scripts/patch-wechaty-puppet-wechat.mjs" ]]; then
    echo "[deploy] Refreshing Wechaty patch on existing node_modules"
    run_as_app_user "node scripts/patch-wechaty-puppet-wechat.mjs"
  fi
}

install_dependencies_if_needed() {
  local current_lock_signature install_reason installed_lock_signature

  current_lock_signature="$(compute_normalized_lock_signature "${APP_DIR}/package-lock.json")"

  if [[ ! -d "${APP_DIR}/node_modules" ]]; then
    install_reason="node_modules is missing"
  elif [[ ! -f "${APP_DIR}/node_modules/.package-lock.json" ]]; then
    install_reason="installed dependency lock is missing"
  elif [[ ! -x "${APP_DIR}/node_modules/.bin/tsc" ]]; then
    install_reason="TypeScript build tool is missing"
  elif [[ ! -f "${APP_DIR}/node_modules/wechaty-puppet-wechat/package.json" ]]; then
    install_reason="wechaty-puppet-wechat is missing"
  else
    installed_lock_signature="$(compute_normalized_lock_signature "${APP_DIR}/node_modules/.package-lock.json")"
    if [[ "${installed_lock_signature}" != "${current_lock_signature}" ]]; then
      install_reason="dependency tree changed"
    fi
  fi

  if [[ -n "${install_reason:-}" ]]; then
    echo "[deploy] Installing Node.js dependencies with npm ci (${install_reason})"
    run_as_app_user "npm ci"
    refresh_postinstall_patch
    return
  fi

  echo "[deploy] Skipping npm ci (installed dependency tree matches package-lock.json)"
  refresh_postinstall_patch
}

echo "[deploy] Pulling latest code from origin/main"
run_as_app_user "git pull --ff-only origin main"

if [[ -f "${service_source}" ]]; then
  echo "[deploy] Installing systemd unit"
  install -m 644 -o root -g root "${service_source}" "${service_target}"
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

echo "[deploy] Service status"
systemctl --no-pager --full status "${SERVICE_NAME}"
