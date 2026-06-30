#!/usr/bin/env bash

set -euo pipefail

APP_DIR="/opt/wechat-claw/current"
APP_USER="wechatclaw"
ENV_FILE="/etc/wechat-claw.env"
SERVICE_NAME="wechat-claw"
ADMIN_SERVICE_NAME="wechat-claw-reimbursement-admin"
WATCHDOG_SERVICE_NAME="wechat-claw-watchdog"
WATCHDOG_TIMER_NAME="wechat-claw-watchdog"
DAILY_RESTART_SERVICE_NAME="wechat-claw-daily-restart"
DAILY_RESTART_TIMER_NAME="wechat-claw-daily-restart"
SYSTEMD_UNIT_DIR="/etc/systemd/system"
NGINX_AVAILABLE_DIR="/etc/nginx/sites-available"
NGINX_ENABLED_DIR="/etc/nginx/sites-enabled"
NGINX_SNIPPETS_DIR="/etc/nginx/snippets"
NGINX_INCLUDE_NAME="wechat-claw-reimbursement-admin.locations.conf"
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

wait_for_http_ok() {
  local label="$1"
  local url="$2"
  local attempts="${3:-30}"
  local sleep_seconds="${4:-1}"
  local attempt

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl --fail --silent --show-error "${url}" >/dev/null 2>&1; then
      echo "[deploy] ${label} is healthy"
      return 0
    fi

    sleep "${sleep_seconds}"
  done

  echo "[deploy] ${label} failed health check: ${url}" >&2
  return 1
}

render_nginx_locations() {
  local source_path="$1"
  local target_path="$2"
  local admin_upstream="$3"
  local rendered_path

  rendered_path="$(mktemp /tmp/wechat-claw-nginx.XXXXXX)"
  sed "s#127.0.0.1:8788#${admin_upstream}#g" "${source_path}" > "${rendered_path}"
  install -m 644 -o root -g root "${rendered_path}" "${target_path}"
  rm -f "${rendered_path}"
}

ensure_nginx_include_in_site() {
  local site_path="$1"
  local include_line="$2"
  local rendered_path

  if grep -Fqx "${include_line}" "${site_path}"; then
    echo "[deploy] Nginx site already includes reimbursement admin snippet"
    return 0
  fi

  rendered_path="$(mktemp /tmp/wechat-claw-nginx-site.XXXXXX)"
  awk -v include_line="${include_line}" '
    {
      lines[NR] = $0
      if ($0 ~ /^[[:space:]]*}[[:space:]]*$/) {
        last_brace = NR
      }
    }
    END {
      if (!last_brace) {
        exit 1
      }

      for (i = 1; i <= NR; i++) {
        if (i == last_brace) {
          print include_line
        }

        print lines[i]
      }
    }
  ' "${site_path}" > "${rendered_path}" || {
    rm -f "${rendered_path}"
    echo "Failed to patch nginx site config: ${site_path}" >&2
    exit 1
  }

  install -m 644 -o root -g root "${rendered_path}" "${site_path}"
  rm -f "${rendered_path}"
  echo "[deploy] Added reimbursement admin snippet include to nginx site"
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

for cmd in curl git install ln nginx node npm systemctl sudo; do
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

set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

ADMIN_HOST="${WECHATY_ADMIN_HOST:-127.0.0.1}"
ADMIN_PORT="${WECHATY_ADMIN_PORT:-8788}"
ADMIN_UPSTREAM="${ADMIN_HOST}:${ADMIN_PORT}"
ADMIN_HEALTHZ_HOST="${ADMIN_HOST}"
if [[ "${ADMIN_HEALTHZ_HOST}" == "0.0.0.0" ]]; then
  ADMIN_HEALTHZ_HOST="127.0.0.1"
fi
ADMIN_HEALTHZ_NODE_URL="http://${ADMIN_HEALTHZ_HOST}:${ADMIN_PORT}/reimbursement/healthz"
NGINX_SITE_NAME="${WECHATY_ADMIN_NGINX_SITE_NAME:-invoice-submit}"
NGINX_WEB_HEALTHZ_URL="${WECHATY_ADMIN_NGINX_HEALTHZ_URL:-http://127.0.0.1:8080/reimbursement/healthz}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
service_source="${script_dir}/wechat-claw.service"
service_target="${SYSTEMD_UNIT_DIR}/${SERVICE_NAME}.service"
admin_service_source="${script_dir}/wechat-claw-reimbursement-admin.service"
admin_service_target="${SYSTEMD_UNIT_DIR}/${ADMIN_SERVICE_NAME}.service"
nginx_locations_source="${script_dir}/nginx/reimbursement-admin.locations.conf"
nginx_site_target="${NGINX_AVAILABLE_DIR}/${NGINX_SITE_NAME}"
nginx_enabled_target="${NGINX_ENABLED_DIR}/${NGINX_SITE_NAME}"
nginx_snippet_target="${NGINX_SNIPPETS_DIR}/${NGINX_INCLUDE_NAME}"
nginx_include_line="  include ${nginx_snippet_target};"
watchdog_service_source="${script_dir}/wechat-claw-watchdog.service"
watchdog_service_target="${SYSTEMD_UNIT_DIR}/${WATCHDOG_SERVICE_NAME}.service"
watchdog_timer_source="${script_dir}/wechat-claw-watchdog.timer"
watchdog_timer_target="${SYSTEMD_UNIT_DIR}/${WATCHDOG_TIMER_NAME}.timer"
daily_restart_service_source="${script_dir}/wechat-claw-daily-restart.service"
daily_restart_service_target="${SYSTEMD_UNIT_DIR}/${DAILY_RESTART_SERVICE_NAME}.service"
daily_restart_timer_source="${script_dir}/wechat-claw-daily-restart.timer"
daily_restart_timer_target="${SYSTEMD_UNIT_DIR}/${DAILY_RESTART_TIMER_NAME}.timer"
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

bind_puppeteer_cache_into_runtime() {
  echo "[deploy] Binding persistent Puppeteer cache into runtime path"
  run_as_app_user "if [[ -d 'node_modules/puppeteer' ]]; then rm -rf 'node_modules/puppeteer/.local-chromium'; ln -sfn '${PUPPETEER_CACHE_DIR}' 'node_modules/puppeteer/.local-chromium'; fi"
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
    bind_puppeteer_cache_into_runtime
    return
  fi

  echo "[deploy] Skipping npm ci (installed dependency tree matches package-lock.json)"
  refresh_postinstall_patch
  bind_puppeteer_cache_into_runtime
}

echo "[deploy] Pulling latest code from origin/main"
run_as_app_user "git pull --ff-only origin main"

if systemctl list-unit-files "${WATCHDOG_TIMER_NAME}.timer" >/dev/null 2>&1; then
  echo "[deploy] Stopping watchdog timer during deploy"
  systemctl stop "${WATCHDOG_TIMER_NAME}.timer" "${WATCHDOG_SERVICE_NAME}.service" || true
fi

if systemctl list-unit-files "${DAILY_RESTART_TIMER_NAME}.timer" >/dev/null 2>&1; then
  echo "[deploy] Stopping daily restart timer during deploy"
  systemctl stop "${DAILY_RESTART_TIMER_NAME}.timer" "${DAILY_RESTART_SERVICE_NAME}.service" || true
fi

if [[ -f "${service_source}" ]]; then
  echo "[deploy] Installing systemd unit"
  install -m 644 -o root -g root "${service_source}" "${service_target}"
fi

if [[ -f "${admin_service_source}" ]]; then
  echo "[deploy] Installing reimbursement admin service unit"
  install -m 644 -o root -g root "${admin_service_source}" "${admin_service_target}"
fi

if [[ -f "${watchdog_service_source}" ]]; then
  echo "[deploy] Installing watchdog service unit"
  install -m 644 -o root -g root "${watchdog_service_source}" "${watchdog_service_target}"
fi

if [[ -f "${watchdog_timer_source}" ]]; then
  echo "[deploy] Installing watchdog timer unit"
  install -m 644 -o root -g root "${watchdog_timer_source}" "${watchdog_timer_target}"
fi

if [[ -f "${daily_restart_service_source}" ]]; then
  echo "[deploy] Installing daily restart service unit"
  install -m 644 -o root -g root "${daily_restart_service_source}" "${daily_restart_service_target}"
fi

if [[ -f "${daily_restart_timer_source}" ]]; then
  echo "[deploy] Installing daily restart timer unit"
  install -m 644 -o root -g root "${daily_restart_timer_source}" "${daily_restart_timer_target}"
fi

if [[ ! -f "${nginx_locations_source}" ]]; then
  echo "Missing nginx snippet template: ${nginx_locations_source}" >&2
  exit 1
fi

if [[ ! -f "${nginx_site_target}" ]]; then
  echo "Nginx site config does not exist: ${nginx_site_target}" >&2
  echo "Set WECHATY_ADMIN_NGINX_SITE_NAME in ${ENV_FILE} if /reimbursement should be attached to a different site." >&2
  exit 1
fi

echo "[deploy] Ensuring nginx directories exist"
install -d -m 755 -o root -g root "${NGINX_AVAILABLE_DIR}" "${NGINX_ENABLED_DIR}" "${NGINX_SNIPPETS_DIR}"

echo "[deploy] Installing reimbursement admin nginx snippet"
render_nginx_locations "${nginx_locations_source}" "${nginx_snippet_target}" "${ADMIN_UPSTREAM}"

echo "[deploy] Ensuring nginx site ${NGINX_SITE_NAME} includes reimbursement admin snippet"
ensure_nginx_include_in_site "${nginx_site_target}" "${nginx_include_line}"
ln -sfn "${nginx_site_target}" "${nginx_enabled_target}"

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
if [[ -f "${admin_service_source}" ]]; then
  echo "[deploy] Enabling and restarting ${ADMIN_SERVICE_NAME}"
  systemctl enable "${ADMIN_SERVICE_NAME}" >/dev/null
  systemctl restart "${ADMIN_SERVICE_NAME}"
fi
sleep 5

echo "[deploy] Enabling nginx service"
systemctl enable nginx >/dev/null

echo "[deploy] Validating nginx config"
nginx -t

echo "[deploy] Reloading nginx"
systemctl reload nginx

if [[ -f "${watchdog_service_source}" && -f "${watchdog_timer_source}" ]]; then
  echo "[deploy] Enabling watchdog timer"
  systemctl enable --now "${WATCHDOG_TIMER_NAME}.timer"
fi

if [[ -f "${daily_restart_service_source}" && -f "${daily_restart_timer_source}" ]]; then
  echo "[deploy] Enabling daily restart timer"
  systemctl enable --now "${DAILY_RESTART_TIMER_NAME}.timer"
fi

echo "[deploy] Verifying health endpoints"
if ! wait_for_http_ok "Reimbursement admin health endpoint" "${ADMIN_HEALTHZ_NODE_URL}" 30 1; then
  systemctl --no-pager --full status "${ADMIN_SERVICE_NAME}" || true
  journalctl -u "${ADMIN_SERVICE_NAME}" -n 100 --no-pager || true
  exit 1
fi

if ! wait_for_http_ok "Nginx reimbursement health endpoint" "${NGINX_WEB_HEALTHZ_URL}" 30 1; then
  systemctl --no-pager --full status nginx || true
  systemctl --no-pager --full status "${ADMIN_SERVICE_NAME}" || true
  exit 1
fi

echo "[deploy] Service status"
systemctl --no-pager --full status "${SERVICE_NAME}"

if [[ -f "${admin_service_source}" ]]; then
  echo "[deploy] Admin service status"
  systemctl --no-pager --full status "${ADMIN_SERVICE_NAME}"
fi
