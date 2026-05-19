#!/usr/bin/env bash

set -euo pipefail

TARGET_ENV_FILE="/etc/wechat-claw.env"

usage() {
  cat <<'EOF'
Usage:
  install-wechat-claw-env <source-env-file> [target-env-file]

Description:
  Install a server environment file with secure permissions.
  The existing target file will be backed up before replacement.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run this script as root or with sudo." >&2
  exit 1
fi

SOURCE_FILE="${1:-}"
if [[ -z "${SOURCE_FILE}" ]]; then
  usage >&2
  exit 1
fi

if [[ ! -f "${SOURCE_FILE}" ]]; then
  echo "Source env file does not exist: ${SOURCE_FILE}" >&2
  exit 1
fi

if [[ -n "${2:-}" ]]; then
  TARGET_ENV_FILE="${2}"
fi

timestamp="$(date +%Y%m%d%H%M%S)"

if [[ -f "${TARGET_ENV_FILE}" ]]; then
  cp "${TARGET_ENV_FILE}" "${TARGET_ENV_FILE}.bak.${timestamp}"
  echo "[env] Backup created: ${TARGET_ENV_FILE}.bak.${timestamp}"
fi

install -m 600 -o root -g root "${SOURCE_FILE}" "${TARGET_ENV_FILE}"
echo "[env] Installed ${SOURCE_FILE} -> ${TARGET_ENV_FILE}"
