#!/usr/bin/env bash

set -euo pipefail

TARGET_ENV_FILE="/etc/wechat-claw.env"
EDITOR_COMMAND="${VISUAL:-${EDITOR:-vi}}"
ENV_KEY="WECHATY_CHANNELS_JSON"

usage() {
  cat <<'EOF'
Usage:
  deploy/edit-wechat-claw-channels-json.sh [options] [env-file]

Options:
  --editor <command>  Editor command used for the temporary JSON file
  -h, --help          Show help

Description:
  Extract WECHATY_CHANNELS_JSON from an env file into a formatted JSON file,
  open it in your editor, validate that it is a JSON array, then write it back
  as a single-line env value. A timestamped backup is created before saving.

Examples:
  sudo bash deploy/edit-wechat-claw-channels-json.sh
  sudo bash deploy/edit-wechat-claw-channels-json.sh /etc/wechat-claw.env
  EDITOR=vim sudo bash deploy/edit-wechat-claw-channels-json.sh
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --editor)
      EDITOR_COMMAND="${2:-}"
      shift 2
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
      if [[ "${TARGET_ENV_FILE}" == "/etc/wechat-claw.env" ]]; then
        TARGET_ENV_FILE="$1"
      else
        echo "Unexpected argument: $1" >&2
        usage >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "${EDITOR_COMMAND//[[:space:]]/}" ]]; then
  EDITOR_COMMAND="vi"
fi

for cmd in awk cp install mktemp node; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing required command: ${cmd}" >&2
    exit 1
  fi
done

target_dir="${TARGET_ENV_FILE%/*}"
if [[ "${target_dir}" == "${TARGET_ENV_FILE}" ]]; then
  target_dir="."
fi

if [[ -f "${TARGET_ENV_FILE}" ]]; then
  if [[ ! -r "${TARGET_ENV_FILE}" ]]; then
    echo "Env file is not readable: ${TARGET_ENV_FILE}" >&2
    exit 1
  fi

  if [[ ! -w "${TARGET_ENV_FILE}" && "${EUID}" -ne 0 ]]; then
    echo "Env file is not writable. Please run this script as root or with sudo." >&2
    exit 1
  fi
else
  if [[ ! -d "${target_dir}" ]]; then
    echo "Target directory does not exist: ${target_dir}" >&2
    exit 1
  fi

  if [[ ! -w "${target_dir}" && "${EUID}" -ne 0 ]]; then
    echo "Target directory is not writable. Please run this script as root or with sudo." >&2
    exit 1
  fi
fi

tmp_json="$(mktemp /tmp/wechat-claw.channels.XXXXXX)"
tmp_env="$(mktemp /tmp/wechat-claw.env.XXXXXX)"
backup_path=""

cleanup() {
  rm -f "${tmp_json}" "${tmp_env}"
}
trap cleanup EXIT

extract_raw_env_value() {
  local env_file="$1"

  awk -v key="${ENV_KEY}" '
    index($0, key "=") == 1 {
      print substr($0, length(key) + 2)
      found = 1
      exit
    }

    END {
      if (!found) {
        exit 1
      }
    }
  ' "${env_file}"
}

decode_shell_env_value() {
  local raw_value="$1"
  local tmp_assignment decode_status

  tmp_assignment="$(mktemp /tmp/wechat-claw.env-value.XXXXXX)"
  printf '%s=%s\n' "${ENV_KEY}" "${raw_value}" > "${tmp_assignment}"

  ENV_KEY_NAME="${ENV_KEY}" TMP_ENV_ASSIGNMENT="${tmp_assignment}" bash -lc '
    set -euo pipefail
    key="${ENV_KEY_NAME}"
    set -a
    . "${TMP_ENV_ASSIGNMENT}"
    set +a
    printf "%s" "${!key}"
  '
  decode_status=$?
  rm -f "${tmp_assignment}"

  return "${decode_status}"
}

extract_env_value() {
  local env_file="$1"
  local raw_value decoded_value

  raw_value="$(extract_raw_env_value "${env_file}")" || return 1

  if decoded_value="$(decode_shell_env_value "${raw_value}" 2>/dev/null)"; then
    printf '%s' "${decoded_value}"
    return 0
  fi

  printf '%s' "${raw_value}"
}

write_pretty_json() {
  local raw_json="$1"
  local output_file="$2"

  printf '%s' "${raw_json}" | node -e '
    const fs = require("node:fs");

    const input = fs.readFileSync(0, "utf8");
    const parsed = JSON.parse(input);

    if (!Array.isArray(parsed)) {
      console.error("WECHATY_CHANNELS_JSON must be a JSON array");
      process.exit(1);
    }

    fs.writeFileSync(process.argv[1], JSON.stringify(parsed, null, 2) + "\n");
  ' "${output_file}"
}

minify_json_file() {
  local input_file="$1"

  node -e '
    const fs = require("node:fs");

    const input = fs.readFileSync(process.argv[1], "utf8");
    const parsed = JSON.parse(input);

    if (!Array.isArray(parsed)) {
      console.error("WECHATY_CHANNELS_JSON must be a JSON array");
      process.exit(1);
    }

    process.stdout.write(JSON.stringify(parsed));
  ' "${input_file}"
}

open_editor() {
  local target_file="$1"

  EDITOR_COMMAND_ENV="${EDITOR_COMMAND}" EDITOR_TARGET_FILE="${target_file}" \
    bash -lc '${EDITOR_COMMAND_ENV} "${EDITOR_TARGET_FILE}"'
}

if [[ -f "${TARGET_ENV_FILE}" ]] && raw_json="$(extract_env_value "${TARGET_ENV_FILE}" 2>/dev/null)"; then
  if write_pretty_json "${raw_json}" "${tmp_json}" 2>/dev/null; then
    echo "[edit-env] Loaded ${ENV_KEY} from ${TARGET_ENV_FILE}"
  else
    printf '%s\n' "${raw_json}" > "${tmp_json}"
    echo "[edit-env] Existing ${ENV_KEY} is not valid JSON. Opening the raw value for manual repair."
  fi
else
  printf '[]\n' > "${tmp_json}"
  echo "[edit-env] ${ENV_KEY} not found. Initializing with an empty JSON array."
fi

if ! open_editor "${tmp_json}"; then
  echo "[edit-env] Editor exited without saving changes." >&2
  exit 1
fi

if ! minified_json="$(minify_json_file "${tmp_json}")"; then
  echo "[edit-env] Edited content must be a valid JSON array." >&2
  exit 1
fi

if [[ -f "${TARGET_ENV_FILE}" ]]; then
  timestamp="$(date +%Y%m%d%H%M%S)"
  backup_path="${TARGET_ENV_FILE}.bak.${timestamp}"
  cp "${TARGET_ENV_FILE}" "${backup_path}"
fi

if [[ -f "${TARGET_ENV_FILE}" ]]; then
  awk -v key="${ENV_KEY}" -v new_line="${ENV_KEY}=${minified_json}" '
    index($0, key "=") == 1 {
      if (!replaced) {
        print new_line
      }
      replaced = 1
      next
    }

    {
      print
    }

    END {
      if (!replaced) {
        print new_line
      }
    }
  ' "${TARGET_ENV_FILE}" > "${tmp_env}"

  cat "${tmp_env}" > "${TARGET_ENV_FILE}"
else
  printf '%s=%s\n' "${ENV_KEY}" "${minified_json}" > "${tmp_env}"
  install -m 600 "${tmp_env}" "${TARGET_ENV_FILE}"
fi

if [[ -n "${backup_path}" ]]; then
  echo "[edit-env] Backup created: ${backup_path}"
fi

echo "[edit-env] Saved ${ENV_KEY} to ${TARGET_ENV_FILE}"
echo "[edit-env] Restart the service to apply the new config: sudo systemctl restart wechat-claw"
