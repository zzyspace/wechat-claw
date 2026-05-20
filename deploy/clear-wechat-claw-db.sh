#!/usr/bin/env bash

set -euo pipefail

SERVICE_NAME="wechat-claw"
ENV_FILE="/etc/wechat-claw.env"
DB_PATH=""
BACKUP_BEFORE_CLEAR=1
ASSUME_YES=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_DB_HELPER="${SCRIPT_DIR}/clear-wechat-claw-db.mjs"
DB_BACKEND=""

usage() {
  cat <<'EOF'
Usage:
  deploy/clear-wechat-claw-db.sh [options]

Description:
  Stop the wechat-claw service, clear all SQLite business data while keeping
  the database file and tables, then start the service again.

Options:
  --service-name <name>  systemd service name. Default: wechat-claw
  --env-file <path>      Env file used to resolve WECHATY_STATE_DIR.
                         Default: /etc/wechat-claw.env
  --db-path <path>       Override the SQLite database path directly.
  --no-backup            Skip the pre-clear SQLite backup.
  -y, --yes              Skip the confirmation prompt.
  -h, --help             Show help.

Examples:
  sudo bash deploy/clear-wechat-claw-db.sh
  sudo bash deploy/clear-wechat-claw-db.sh --yes
  sudo bash deploy/clear-wechat-claw-db.sh --db-path /var/lib/wechat-claw/wechat-claw.sqlite --yes
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
    --db-path)
      DB_PATH="$2"
      shift 2
      ;;
    --no-backup)
      BACKUP_BEFORE_CLEAR=0
      shift
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

if ! command -v systemctl >/dev/null 2>&1; then
  echo "Missing required command: systemctl" >&2
  exit 1
fi

if command -v sqlite3 >/dev/null 2>&1; then
  DB_BACKEND="sqlite3"
elif command -v node >/dev/null 2>&1 && [[ -f "${NODE_DB_HELPER}" ]] && [[ -d "${SCRIPT_DIR}/../node_modules/better-sqlite3" ]]; then
  DB_BACKEND="node"
else
  echo "Missing required database tooling: install sqlite3, or ensure node plus node_modules/better-sqlite3 are available." >&2
  exit 1
fi

if [[ -z "${DB_PATH}" ]]; then
  if [[ ! -f "${ENV_FILE}" ]]; then
    echo "Env file does not exist: ${ENV_FILE}" >&2
    exit 1
  fi

  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a

  STATE_DIR="${WECHATY_STATE_DIR:-/var/lib/wechat-claw}"
  DB_PATH="${STATE_DIR}/wechat-claw.sqlite"
else
  STATE_DIR="$(cd "$(dirname "${DB_PATH}")" && pwd)"
fi

if [[ ! -f "${DB_PATH}" ]]; then
  echo "Database file does not exist: ${DB_PATH}" >&2
  exit 1
fi

timestamp="$(date +%Y%m%d%H%M%S)"
backup_path=""
restart_required=0

show_counts() {
  sqlite3 "${DB_PATH}" "
    SELECT 'raw_messages', COUNT(*) FROM raw_messages
    UNION ALL
    SELECT 'message_attachments', COUNT(*) FROM message_attachments
    UNION ALL
    SELECT 'scenario_extractions', COUNT(*) FROM scenario_extractions
    UNION ALL
    SELECT 'summary_send_requests', COUNT(*) FROM summary_send_requests;
  "
}

cleanup() {
  local exit_code=$?

  if [[ "${restart_required}" -eq 1 ]]; then
    echo "[clear-db] Starting ${SERVICE_NAME}"
    if systemctl start "${SERVICE_NAME}"; then
      echo "[clear-db] ${SERVICE_NAME} started"
    else
      echo "[clear-db] Failed to start ${SERVICE_NAME}. Check: systemctl status ${SERVICE_NAME}" >&2
      exit_code=1
    fi
  fi

  exit "${exit_code}"
}

trap cleanup EXIT

echo "[clear-db] Service: ${SERVICE_NAME}"
echo "[clear-db] Env file: ${ENV_FILE}"
echo "[clear-db] Database: ${DB_PATH}"
echo "[clear-db] Database backend: ${DB_BACKEND}"

if [[ "${BACKUP_BEFORE_CLEAR}" -eq 1 ]]; then
  backup_dir="${STATE_DIR}/backups"
  mkdir -p "${backup_dir}"
  backup_path="${backup_dir}/wechat-claw.sqlite.before-clear.${timestamp}.sqlite"
  echo "[clear-db] Backup will be created: ${backup_path}"
fi

if [[ "${ASSUME_YES}" -ne 1 ]]; then
  echo "[clear-db] This will stop ${SERVICE_NAME}, delete all rows from the SQLite business tables, and start the service again."
  read -r -p "Type CLEAR to continue: " confirmation
  if [[ "${confirmation}" != "CLEAR" ]]; then
    echo "[clear-db] Aborted."
    exit 1
  fi
fi

echo "[clear-db] Stopping ${SERVICE_NAME}"
systemctl stop "${SERVICE_NAME}"
restart_required=1

if [[ "${DB_BACKEND}" == "sqlite3" ]]; then
  echo "[clear-db] Row counts before clear"
  show_counts

  if [[ "${BACKUP_BEFORE_CLEAR}" -eq 1 ]]; then
    echo "[clear-db] Creating SQLite backup"
    sqlite3 "${DB_PATH}" ".backup '${backup_path}'"
  fi

  echo "[clear-db] Clearing SQLite tables"
  sqlite3 "${DB_PATH}" "
    BEGIN IMMEDIATE;
    DELETE FROM scenario_extractions;
    DELETE FROM message_attachments;
    DELETE FROM raw_messages;
    DELETE FROM summary_send_requests;
    COMMIT;
  "

  has_sequence_table="$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence';")"
  if [[ "${has_sequence_table}" == "1" ]]; then
    echo "[clear-db] Resetting AUTOINCREMENT counters"
    sqlite3 "${DB_PATH}" "
      DELETE FROM sqlite_sequence
      WHERE name IN ('raw_messages', 'message_attachments', 'scenario_extractions', 'summary_send_requests');
    "
  fi

  echo "[clear-db] Checkpointing WAL and compacting database"
  sqlite3 "${DB_PATH}" "
    PRAGMA wal_checkpoint(TRUNCATE);
    VACUUM;
  "

  echo "[clear-db] Row counts after clear"
  show_counts
else
  node_args=( "${NODE_DB_HELPER}" clear --db-path "${DB_PATH}" )
  if [[ -n "${backup_path}" ]]; then
    node_args+=( --backup-path "${backup_path}" )
  fi
  node "${node_args[@]}"
fi

echo "[clear-db] Database clear completed"
if [[ -n "${backup_path}" ]]; then
  echo "[clear-db] Backup saved at ${backup_path}"
fi
