#!/usr/bin/env bash

set -euo pipefail

STATE_DIR="/var/lib/wechat-claw"
TIMEZONE="Asia/Shanghai"
REMOTE_ENV_PATH="/etc/wechat-claw.env"
RUN_DEPLOY=0

usage() {
  cat <<'EOF'
Usage:
  deploy/sync-wechat-claw-env.sh [options] <ssh-target> [source-env-file]

Options:
  --state-dir <path>        Server-side WECHATY_STATE_DIR. Default: /var/lib/wechat-claw
  --timezone <tz>           Server-side WECHATY_TIMEZONE. Default: Asia/Shanghai
  --remote-env-path <path>  Remote target env file. Default: /etc/wechat-claw.env
  --deploy                  Run `sudo deploy-wechat-claw` on the server after syncing env
  -h, --help                Show help

Examples:
  deploy/sync-wechat-claw-env.sh root@139.196.140.215
  deploy/sync-wechat-claw-env.sh --deploy root@139.196.140.215 .env
EOF
}

SSH_TARGET=""
SOURCE_ENV_FILE=".env"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-dir)
      STATE_DIR="$2"
      shift 2
      ;;
    --timezone)
      TIMEZONE="$2"
      shift 2
      ;;
    --remote-env-path)
      REMOTE_ENV_PATH="$2"
      shift 2
      ;;
    --deploy)
      RUN_DEPLOY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ -z "${SSH_TARGET}" ]]; then
        SSH_TARGET="$1"
      elif [[ "${SOURCE_ENV_FILE}" == ".env" ]]; then
        SOURCE_ENV_FILE="$1"
      else
        echo "Unexpected argument: $1" >&2
        usage >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "${SSH_TARGET}" ]]; then
  usage >&2
  exit 1
fi

if [[ ! -f "${SOURCE_ENV_FILE}" ]]; then
  echo "Source env file does not exist: ${SOURCE_ENV_FILE}" >&2
  exit 1
fi

for cmd in awk mktemp scp ssh; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing required command: ${cmd}" >&2
    exit 1
  fi
done

rendered_env="$(mktemp /tmp/wechat-claw.env.rendered.XXXXXX)"

cleanup() {
  rm -f "${rendered_env}"
}
trap cleanup EXIT

awk \
  -v state_dir="${STATE_DIR}" \
  -v timezone="${TIMEZONE}" \
  '
  BEGIN {
    has_state_dir = 0
    has_timezone = 0
  }

  /^[[:space:]]*#/ { next }
  /^[[:space:]]*$/ { next }

  {
    if (match($0, /^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/, parts)) {
      key = parts[1]
      value = parts[2]

      if (key == "WECHATY_STATE_DIR") {
        print key "=" state_dir
        has_state_dir = 1
        next
      }

      if (key == "WECHATY_TIMEZONE") {
        print key "=" timezone
        has_timezone = 1
        next
      }

      if (key == "WECHATY_SUMMARY_CRON") {
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        if (value != "" && value !~ /^".*"$/ && value !~ /^'\''.*'\''$/ && value ~ /[[:space:]]/) {
          value = "\"" value "\""
        }
        print key "=" value
        next
      }

      print key "=" value
    }
  }

  END {
    if (!has_state_dir) {
      print "WECHATY_STATE_DIR=" state_dir
    }

    if (!has_timezone) {
      print "WECHATY_TIMEZONE=" timezone
    }
  }
  ' "${SOURCE_ENV_FILE}" > "${rendered_env}"

remote_tmp="/tmp/wechat-claw.env.$(date +%s).$$"

echo "[sync-env] Uploading rendered env to ${SSH_TARGET}:${remote_tmp}"
scp -o StrictHostKeyChecking=no "${rendered_env}" "${SSH_TARGET}:${remote_tmp}"

echo "[sync-env] Installing env to ${REMOTE_ENV_PATH}"
ssh -o StrictHostKeyChecking=no "${SSH_TARGET}" \
  "if command -v install-wechat-claw-env >/dev/null 2>&1; then sudo install-wechat-claw-env '${remote_tmp}' '${REMOTE_ENV_PATH}'; else sudo install -m 600 -o root -g root '${remote_tmp}' '${REMOTE_ENV_PATH}'; fi && rm -f '${remote_tmp}'"

echo "[sync-env] Env sync completed"

if [[ "${RUN_DEPLOY}" -eq 1 ]]; then
  echo "[sync-env] Running remote deploy"
  ssh -o StrictHostKeyChecking=no "${SSH_TARGET}" "sudo deploy-wechat-claw"
fi
