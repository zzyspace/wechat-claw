#!/usr/bin/env bash

set -euo pipefail

SERVICE_NAME="wechat-claw"
ENV_FILE="/etc/wechat-claw.env"
STATE_DIR=""
BOT_NAME=""
BACKUP_DIR=""
WAIT_SECONDS=60
ASSUME_YES=0

usage() {
  cat <<'EOF'
Usage:
  deploy/reset-wechat-session.sh [options]

Description:
  Back up and disable the current Wechaty memory-card session file, restart the
  wechat-claw service, wait for the bot to enter waiting_for_scan, then print
  the QR-code artifact location and URL for a fresh login.

Options:
  --service-name <name>  systemd service name. Default: wechat-claw
  --env-file <path>      Env file used to resolve WECHATY_STATE_DIR and
                         WECHATY_BOT_NAME. Default: /etc/wechat-claw.env
  --state-dir <path>     Override WECHATY_STATE_DIR directly.
  --bot-name <name>      Override WECHATY_BOT_NAME directly.
  --backup-dir <path>    Directory used to store memory-card backups.
                         Default: <state-dir>/backups
  --wait-seconds <n>     Seconds to wait for waiting_for_scan after restart.
                         Default: 60
  -y, --yes              Skip the confirmation prompt.
  -h, --help             Show help.

Examples:
  sudo bash deploy/reset-wechat-session.sh
  sudo bash deploy/reset-wechat-session.sh --yes
  sudo bash deploy/reset-wechat-session.sh --state-dir /var/lib/wechat-claw --bot-name wechat-loss-bot --yes
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service-name)
      SERVICE_NAME="$2"
      shift 2
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --state-dir)
      STATE_DIR="$2"
      shift 2
      ;;
    --bot-name)
      BOT_NAME="$2"
      shift 2
      ;;
    --backup-dir)
      BACKUP_DIR="$2"
      shift 2
      ;;
    --wait-seconds)
      WAIT_SECONDS="$2"
      shift 2
      ;;
    -y|--yes)
      ASSUME_YES=1
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

for cmd in systemctl node date; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing required command: ${cmd}" >&2
    exit 1
  fi
done

if ! [[ "${WAIT_SECONDS}" =~ ^[0-9]+$ ]] || [[ "${WAIT_SECONDS}" -le 0 ]]; then
  echo "Invalid --wait-seconds value: ${WAIT_SECONDS}" >&2
  exit 1
fi

if [[ -z "${STATE_DIR}" || -z "${BOT_NAME}" ]]; then
  if [[ ! -f "${ENV_FILE}" ]]; then
    echo "Env file does not exist: ${ENV_FILE}" >&2
    exit 1
  fi

  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a

  if [[ -z "${STATE_DIR}" ]]; then
    STATE_DIR="${WECHATY_STATE_DIR:-/var/lib/wechat-claw}"
  fi

  if [[ -z "${BOT_NAME}" ]]; then
    BOT_NAME="${WECHATY_BOT_NAME:-wechat-loss-bot}"
  fi
fi

if [[ -z "${BACKUP_DIR}" ]]; then
  BACKUP_DIR="${STATE_DIR}/backups"
fi

HEALTH_PATH="${STATE_DIR}/health.json"
QR_PATH="${STATE_DIR}/latest-qrcode.txt"
CARD_PATH="${STATE_DIR}/${BOT_NAME}.memory-card.json"

json_field_or_empty() {
  local file_path="$1"
  local field_name="$2"

  if [[ ! -f "${file_path}" ]]; then
    return 0
  fi

  node -e '
const fs = require("node:fs");
const [filePath, fieldName] = process.argv.slice(1);
const raw = fs.readFileSync(filePath, "utf8");
const json = JSON.parse(raw);
const value = json[fieldName];
if (value === undefined || value === null) {
  process.exit(0);
}
process.stdout.write(String(value));
' "${file_path}" "${field_name}" 2>/dev/null || true
}

print_health_summary() {
  if [[ ! -f "${HEALTH_PATH}" ]]; then
    echo "[reset-session] health.json not found yet: ${HEALTH_PATH}"
    return
  fi

  local status pid last_login_at last_message_at last_scan_at started_at
  status="$(json_field_or_empty "${HEALTH_PATH}" "status")"
  pid="$(json_field_or_empty "${HEALTH_PATH}" "pid")"
  started_at="$(json_field_or_empty "${HEALTH_PATH}" "startedAt")"
  last_scan_at="$(json_field_or_empty "${HEALTH_PATH}" "lastScanAt")"
  last_login_at="$(json_field_or_empty "${HEALTH_PATH}" "lastLoginAt")"
  last_message_at="$(json_field_or_empty "${HEALTH_PATH}" "lastMessageAt")"

  echo "[reset-session] health.status=${status:-"(missing)"} pid=${pid:-"(missing)"} startedAt=${started_at:-"(missing)"}"
  echo "[reset-session] health.lastScanAt=${last_scan_at:-"(null)"} lastLoginAt=${last_login_at:-"(null)"} lastMessageAt=${last_message_at:-"(null)"}"
}

print_qr_summary() {
  if [[ ! -f "${QR_PATH}" ]]; then
    echo "[reset-session] QR artifact not found yet: ${QR_PATH}"
    return
  fi

  local qr_url updated_at
  qr_url="$(sed -n 's/^qrcode_url=//p' "${QR_PATH}" | head -n 1)"
  updated_at="$(sed -n 's/^updated_at=//p' "${QR_PATH}" | head -n 1)"

  echo "[reset-session] QR artifact: ${QR_PATH}"
  echo "[reset-session] QR updated_at: ${updated_at:-"(missing)"}"
  echo "[reset-session] QR url: ${qr_url:-"(missing)"}"
  echo "[reset-session] QR preview:"
  sed -n '1,20p' "${QR_PATH}"
}

qr_artifact_is_fresh() {
  if [[ ! -f "${QR_PATH}" ]]; then
    return 1
  fi

  local qr_mtime
  qr_mtime="$(stat -c %Y "${QR_PATH}" 2>/dev/null || true)"

  if [[ -z "${qr_mtime}" ]]; then
    return 1
  fi

  [[ "${qr_mtime}" -ge "${RESTART_REQUESTED_AT_EPOCH}" ]]
}

wait_for_recovery_ready() {
  local deadline=$((SECONDS + WAIT_SECONDS))
  local status=""

  while (( SECONDS < deadline )); do
    status="$(json_field_or_empty "${HEALTH_PATH}" "status")"
    if [[ "${status}" == "waiting_for_scan" || "${status}" == "logged_in" ]]; then
      return 0
    fi

    if qr_artifact_is_fresh; then
      return 0
    fi
    sleep 1
  done

  return 1
}

timestamp="$(date +%Y%m%dT%H%M%S)"
backup_path="${BACKUP_DIR}/${BOT_NAME}.memory-card.${timestamp}.json"
disabled_path="${CARD_PATH}.disabled.${timestamp}"

echo "[reset-session] Service: ${SERVICE_NAME}"
echo "[reset-session] Env file: ${ENV_FILE}"
echo "[reset-session] State dir: ${STATE_DIR}"
echo "[reset-session] Bot name: ${BOT_NAME}"
echo "[reset-session] Health file: ${HEALTH_PATH}"
echo "[reset-session] Memory-card: ${CARD_PATH}"
echo "[reset-session] Backup path: ${backup_path}"
echo "[reset-session] Disabled path: ${disabled_path}"
print_health_summary

if [[ "${ASSUME_YES}" -ne 1 ]]; then
  echo "[reset-session] This will back up and disable the current memory-card, restart ${SERVICE_NAME}, and force a fresh QR login."
  read -r -p "Type RESET to continue: " confirmation
  if [[ "${confirmation}" != "RESET" ]]; then
    echo "[reset-session] Aborted."
    exit 1
  fi
fi

mkdir -p "${BACKUP_DIR}"

if [[ -f "${CARD_PATH}" ]]; then
  echo "[reset-session] Backing up current memory-card"
  cp -p "${CARD_PATH}" "${backup_path}"

  echo "[reset-session] Disabling current memory-card"
  mv "${CARD_PATH}" "${disabled_path}"
else
  echo "[reset-session] No active memory-card file found, continuing with service restart"
fi

echo "[reset-session] Restarting ${SERVICE_NAME}"
RESTART_REQUESTED_AT_EPOCH="$(date +%s)"
systemctl restart "${SERVICE_NAME}"

echo "[reset-session] Waiting up to ${WAIT_SECONDS}s for waiting_for_scan, logged_in, or a freshly generated QR artifact"
if wait_for_recovery_ready; then
  print_health_summary
  print_qr_summary
  echo "[reset-session] Fresh-login recovery is ready. Scan the QR code and wait for Bot logged in."
  exit 0
fi

print_health_summary
echo "[reset-session] Timed out waiting for health.status=waiting_for_scan"
echo "[reset-session] Inspect service status: systemctl status ${SERVICE_NAME}"
echo "[reset-session] Inspect logs: journalctl -u ${SERVICE_NAME} -n 100 --no-pager -o short-iso"
exit 1
